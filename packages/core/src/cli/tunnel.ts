import { EventEmitter } from "node:events";
import {
  defaultProvider,
  type ParsedStdoutEvent,
  type TunnelChildProcess,
  type TunnelProvider,
} from "./tunnel-providers/index.js";

export type {
  ParsedStdoutEvent,
  TunnelChildProcess,
  TunnelProvider,
} from "./tunnel-providers/index.js";

export type TunnelState =
  | { status: "idle" }
  | { status: "starting"; message: string }
  | { status: "connected"; url: string }
  | { status: "reconnecting"; message: string }
  | { status: "error"; message: string };

/**
 * Parse a single stdout line using the default (srv.us) provider. Kept as a
 * standalone export for tests and callers that want the default parser.
 */
export function parseStdoutLine(line: string): ParsedStdoutEvent | null {
  return defaultProvider.parseLine(line);
}

const CONNECT_TIMEOUT_MS = 60_000;
const STDERR_BUFFER_BYTES = 1024;
/** Backoff before respawning after an unexpected drop. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export type TunnelActivity = {
  time: string;
  text: string;
  level: "log" | "error";
};

/**
 * Legacy spawn injection. A bare `(port) => child` function; when provided it is
 * adapted into a provider that uses the default (srv.us) line parser. New code
 * should pass a full `provider` instead.
 */
export type SpawnFn = (port: number) => TunnelChildProcess;

function providerFromSpawn(spawnFn: SpawnFn): TunnelProvider {
  return {
    name: "custom",
    spawn: spawnFn,
    parseLine: defaultProvider.parseLine,
  };
}

export class TunnelManager extends EventEmitter {
  private state: TunnelState = { status: "idle" };
  private child: ReturnType<SpawnFn> | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stderrBuffer = "";
  private connected = false;
  /** True between start() and stop(): governs whether drops trigger reconnect. */
  private wantUp = false;
  private reconnectAttempts = 0;
  private ensured = false;
  private readonly getPort: () => number;
  private readonly provider: TunnelProvider;

  constructor(opts: {
    getPort: () => number;
    provider?: TunnelProvider;
    /** @deprecated pass `provider` instead. */
    spawn?: SpawnFn;
  }) {
    super();
    this.getPort = opts.getPort;
    this.provider =
      opts.provider ??
      (opts.spawn ? providerFromSpawn(opts.spawn) : defaultProvider);
    // Multiple SSE subscribers (CLI, devtools, ad-hoc curl) can each register
    // state + activity listeners; the default cap of 10 is easy to hit.
    this.setMaxListeners(0);
  }

  getState(): TunnelState {
    return this.state;
  }

  subscribe(listener: (state: TunnelState) => void): () => void {
    listener(this.state);
    this.on("state", listener);
    return () => {
      this.off("state", listener);
    };
  }

  start(): void {
    if (
      this.state.status === "starting" ||
      this.state.status === "connected" ||
      this.state.status === "reconnecting"
    ) {
      return;
    }
    this.wantUp = true;
    this.reconnectAttempts = 0;
    void this.spawnChild({ status: "starting", message: "Starting tunnel…" });
  }

  /**
   * Spawn (or respawn) the tunnel child. `initialState` is what we broadcast
   * while waiting for the URL — "starting" on first launch, "reconnecting" after
   * a drop. Ensures provider prerequisites (e.g. SSH key) once, lazily.
   */
  private async spawnChild(initialState: TunnelState): Promise<void> {
    this.connected = false;
    this.stderrBuffer = "";
    this.setState(initialState);

    if (!this.ensured && this.provider.ensure) {
      try {
        await this.provider.ensure();
        this.ensured = true;
      } catch (err) {
        if (!this.wantUp) {
          return;
        }
        this.setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    // A stop() may have raced the await above.
    if (!this.wantUp) {
      return;
    }

    let child: TunnelChildProcess;
    try {
      child = this.provider.spawn(this.getPort());
    } catch (err) {
      this.setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.child = child;

    this.timeout = setTimeout(() => {
      if (!this.connected) {
        this.setState({
          status: "error",
          message: "Tunnel connection timed out after one minute",
        });
        // Detach before killing so the imminent `close` event is treated as
        // stale and does not overwrite the timeout error message / reconnect.
        this.child = null;
        this.wantUp = false;
        child.kill();
      }
    }, CONNECT_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      this.handleStdout(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.handleStderr(data);
    });

    child.on("error", (err: Error) => {
      // Stale event from a child we've already replaced via stop()+start().
      if (child !== this.child) {
        return;
      }
      this.clearConnectTimeout();
      this.child = null;
      if (this.wantUp) {
        this.scheduleReconnect(err.message);
      } else {
        this.setState({ status: "error", message: err.message });
      }
    });

    child.on("close", (code: number | null) => {
      // Stale event from a child we've already replaced via stop()+start().
      if (child !== this.child) {
        return;
      }
      this.clearConnectTimeout();
      this.child = null;

      // Wanted up but the process exited → unexpected drop, reconnect.
      if (this.wantUp) {
        const detail =
          this.stderrBuffer.trim() ||
          (code !== null ? `tunnel exited with code ${code}` : "tunnel closed");
        this.scheduleReconnect(detail);
        return;
      }

      if (code !== 0 && code !== null) {
        const detail = this.stderrBuffer.trim() || `exited with code ${code}`;
        this.setState({ status: "error", message: detail });
      } else {
        this.setState({ status: "idle" });
      }
    });
  }

  /**
   * After an unexpected drop, broadcast "reconnecting" and respawn after an
   * exponential backoff (capped). Reset attempts once a connection succeeds.
   */
  private scheduleReconnect(reason: string): void {
    if (!this.wantUp) {
      this.setState({ status: "idle" });
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.setState({
      status: "reconnecting",
      message: `Tunnel dropped (${reason}); reconnecting…`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantUp) {
        return;
      }
      void this.spawnChild({
        status: "reconnecting",
        message: "Reconnecting tunnel…",
      });
    }, delay);
  }

  stop(): void {
    this.wantUp = false;
    this.clearConnectTimeout();
    this.clearReconnectTimer();
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.setState({ status: "idle" });
  }

  private handleStdout(data: Buffer): void {
    const lines = data.toString().split("\n");
    for (const raw of lines) {
      const parsed = this.provider.parseLine(raw);
      if (!parsed) {
        continue;
      }
      if (parsed.kind === "connected") {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.clearConnectTimeout();
        this.setState({ status: "connected", url: parsed.url });
      } else if (this.connected) {
        this.emitActivity(parsed.message, "log");
      } else {
        this.setState({ status: "starting", message: parsed.message });
      }
    }
  }

  private handleStderr(data: Buffer): void {
    const text = data.toString().trim();
    if (!text) {
      return;
    }
    this.stderrBuffer = (this.stderrBuffer + text).slice(-STDERR_BUFFER_BYTES);
    for (const line of text.split("\n").filter(Boolean)) {
      this.emitActivity(line, "error");
    }
  }

  private setState(next: TunnelState): void {
    this.state = next;
    this.emit("state", next);
  }

  private emitActivity(text: string, level: "log" | "error"): void {
    const activity: TunnelActivity = {
      time: new Date().toISOString(),
      text,
      level,
    };
    this.emit("activity", activity);
  }

  private clearConnectTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
