import type { Readable } from "node:stream";

/**
 * A spawned tunnel child process. Intentionally a structural subset of
 * `ChildProcess` so it can be faked in tests without a real subprocess.
 */
export type TunnelChildProcess = {
  stdout: Pick<Readable, "on"> | null;
  stderr: Pick<Readable, "on"> | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
};

/**
 * The result of parsing a single line of a provider's stdout.
 *  - `connected`: the public URL is now known and the tunnel is live.
 *  - `starting`: progress text emitted before the URL is known.
 */
export type ParsedStdoutEvent =
  | { kind: "connected"; url: string }
  | { kind: "starting"; message: string };

/**
 * A pluggable tunnel backend. Encapsulates BOTH how the tunnel process is
 * spawned AND how its stdout is parsed for the public URL, since each provider
 * (srv.us, localhost.run, bore, cloudflared…) prints a different format.
 *
 * `TunnelManager` is provider-agnostic: it owns lifecycle/state/reconnect and
 * delegates spawning + line parsing to the provider. Adding a provider therefore
 * never touches the manager or any caller.
 */
export interface TunnelProvider {
  /** Stable identifier, e.g. "srv.us". */
  readonly name: string;
  /**
   * Ensure any prerequisites exist (e.g. an SSH key). Best-effort and lazy;
   * called once before the first spawn. Optional — providers with no setup omit it.
   */
  ensure?(): void | Promise<void>;
  /** Spawn the tunnel for a local port and return the child process. */
  spawn(port: number): TunnelChildProcess;
  /**
   * Parse one stdout line. Return `null` for lines that carry no signal so they
   * can be ignored (or surfaced only under `--verbose`).
   */
  parseLine(line: string): ParsedStdoutEvent | null;
}
