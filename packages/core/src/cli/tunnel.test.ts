import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStdoutLine, TunnelManager, type TunnelState } from "./tunnel.js";

describe("parseStdoutLine (delegates to the default srv.us provider)", () => {
  it("returns a connected event when a srv.us URL is seen", () => {
    const result = parseStdoutLine(
      "https://qp556ma755ktlag5b2xyt334ae.srv.us/",
    );
    expect(result).toEqual({
      kind: "connected",
      url: "https://qp556ma755ktlag5b2xyt334ae.srv.us",
    });
  });

  it("returns a starting event for any other non-empty line", () => {
    expect(parseStdoutLine("Warning: Permanently added 'srv.us'")).toEqual({
      kind: "starting",
      message: "Warning: Permanently added 'srv.us'",
    });
  });

  it("returns null for empty lines", () => {
    expect(parseStdoutLine("")).toBeNull();
    expect(parseStdoutLine("   ")).toBeNull();
  });
});

type FakeChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn<() => boolean>>;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn<() => boolean>(() => true);
  return child;
}

describe("TunnelManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts idle", () => {
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => makeFakeChild(),
    });
    expect(manager.getState()).toEqual({ status: "idle" });
  });

  it("transitions idle -> starting -> connected as stdout reports progress", () => {
    const child = makeFakeChild();
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => child,
    });
    const states: string[] = [];
    manager.on("state", (s: TunnelState) => states.push(s.status));

    manager.start();
    child.stdout.emit("data", Buffer.from("Opening tunnel...\n"));
    child.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));

    expect(states).toEqual(["starting", "starting", "connected"]);
    expect(manager.getState()).toEqual({
      status: "connected",
      url: "https://abc123.srv.us",
    });
  });

  it("emits activity events for stdout lines after connect", () => {
    const child = makeFakeChild();
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => child,
    });
    const activity: Array<{ text: string; level: string }> = [];
    manager.on("activity", (a: { text: string; level: string }) =>
      activity.push({ text: a.text, level: a.level }),
    );

    manager.start();
    child.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));
    child.stdout.emit("data", Buffer.from("GET /widgets/foo\n"));
    child.stderr.emit("data", Buffer.from("connection wobble\n"));

    expect(activity).toEqual([
      { text: "GET /widgets/foo", level: "log" },
      { text: "connection wobble", level: "error" },
    ]);
  });

  it("calling start twice does not spawn twice", () => {
    const spawn = vi.fn(() => makeFakeChild());
    const manager = new TunnelManager({ getPort: () => 3000, spawn });
    manager.start();
    manager.start();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("transitions to error when the connection times out", () => {
    const child = makeFakeChild();
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => child,
    });
    manager.start();

    vi.advanceTimersByTime(60_000);

    expect(manager.getState().status).toBe("error");
    expect(child.kill).toHaveBeenCalled();
  });

  it("preserves the timeout error message when the killed child later emits close", () => {
    const child = makeFakeChild();
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => child,
    });
    manager.start();

    vi.advanceTimersByTime(60_000);
    // The killed child emits a non-zero close after the timeout fired.
    child.emit("close", 1);

    expect(manager.getState()).toEqual({
      status: "error",
      message: "Tunnel connection timed out after one minute",
    });
  });

  it("stop() kills the subprocess and goes idle", () => {
    const child = makeFakeChild();
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => child,
    });
    manager.start();
    manager.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(manager.getState()).toEqual({ status: "idle" });
  });

  it("subscribers get the current state on subscribe", () => {
    const child = makeFakeChild();
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => child,
    });
    manager.start();
    child.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));

    let received: TunnelState | undefined;
    const unsubscribe = manager.subscribe((s) => {
      received = s;
    });
    expect(received).toEqual({
      status: "connected",
      url: "https://abc123.srv.us",
    });
    unsubscribe();
  });

  it("ignores deferred close from a child that was replaced via stop()+start()", () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    let spawnCount = 0;
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => (spawnCount++ === 0 ? childA : childB),
    });

    manager.start();
    manager.stop();
    manager.start();
    childB.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));
    expect(manager.getState()).toEqual({
      status: "connected",
      url: "https://abc123.srv.us",
    });

    // Stale close from childA arrives only now — must not clobber state.
    childA.emit("close", null);
    expect(manager.getState()).toEqual({
      status: "connected",
      url: "https://abc123.srv.us",
    });
  });

  it("ignores deferred error from a child that was replaced via stop()+start()", () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    let spawnCount = 0;
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => (spawnCount++ === 0 ? childA : childB),
    });

    manager.start();
    manager.stop();
    manager.start();
    childB.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));

    childA.emit("error", new Error("late spawn failure"));
    expect(manager.getState()).toEqual({
      status: "connected",
      url: "https://abc123.srv.us",
    });
  });

  it("auto-reconnects when the ssh child exits unexpectedly while up", () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    let spawnCount = 0;
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => (spawnCount++ === 0 ? childA : childB),
    });
    const states: TunnelState[] = [];
    manager.on("state", (s: TunnelState) => states.push(s));

    manager.start();
    childA.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));
    expect(manager.getState().status).toBe("connected");
    expect(spawnCount).toBe(1);

    // ssh drops unexpectedly (e.g. killed / network blip).
    childA.emit("close", null);
    expect(manager.getState().status).toBe("reconnecting");

    // Backoff elapses → respawn.
    vi.advanceTimersByTime(1_000);
    expect(spawnCount).toBe(2);

    // New child connects → back to connected.
    childB.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));
    expect(manager.getState()).toEqual({
      status: "connected",
      url: "https://abc123.srv.us",
    });
    expect(states.map((s) => s.status)).toContain("reconnecting");
  });

  it("stop() during reconnect halts the backoff and does not respawn", () => {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const manager = new TunnelManager({
      getPort: () => 3000,
      spawn: () => children[spawnCount++] ?? makeFakeChild(),
    });

    const first = children[0] as FakeChild;
    manager.start();
    first.stdout.emit("data", Buffer.from("https://abc123.srv.us/\n"));
    first.emit("close", null);
    expect(manager.getState().status).toBe("reconnecting");

    manager.stop();
    expect(manager.getState()).toEqual({ status: "idle" });

    // Even after the backoff window, no respawn happened.
    vi.advanceTimersByTime(60_000);
    expect(spawnCount).toBe(1);
  });

  it("uses the provider's parseLine and ensure hook", async () => {
    const child = makeFakeChild();
    const ensure = vi.fn();
    const manager = new TunnelManager({
      getPort: () => 3000,
      provider: {
        name: "fake",
        ensure,
        spawn: () => child,
        parseLine: (line) => {
          const m = line.match(/READY (\S+)/);
          return m?.[1] ? { kind: "connected", url: m[1] } : null;
        },
      },
    });

    manager.start();
    // ensure() is awaited inside spawnChild; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);

    child.stdout.emit("data", Buffer.from("READY https://x.example\n"));
    expect(manager.getState()).toEqual({
      status: "connected",
      url: "https://x.example",
    });
  });
});
