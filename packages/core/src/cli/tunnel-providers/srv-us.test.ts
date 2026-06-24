import { describe, expect, it } from "vitest";
import {
  parseSrvUsLine,
  srvUsProvider,
  srvUsSshArgs,
  wrapSshSpawnErrors,
} from "./srv-us.js";
import type { TunnelChildProcess } from "./types.js";

describe("parseSrvUsLine", () => {
  it("extracts the URL from srv.us's real on-connect line (live-confirmed format)", () => {
    // Confirmed against a live srv.us tunnel on 2026-06-14: each forwarded port
    // is announced as `<n>: https://<hash>.srv.us/`.
    expect(
      parseSrvUsLine("1: https://65xgxz2werq5kx7rj6fjndeol4.srv.us/"),
    ).toEqual({
      kind: "connected",
      url: "https://65xgxz2werq5kx7rj6fjndeol4.srv.us",
    });
  });

  it("extracts a hash subdomain srv.us URL printed bare", () => {
    expect(
      parseSrvUsLine("https://qp556ma755ktlag5b2xyt334ae.srv.us/"),
    ).toEqual({
      kind: "connected",
      url: "https://qp556ma755ktlag5b2xyt334ae.srv.us",
    });
  });

  it("extracts the URL even when embedded in surrounding text", () => {
    expect(
      parseSrvUsLine("Your service is available at https://abc.srv.us"),
    ).toEqual({
      kind: "connected",
      url: "https://abc.srv.us",
    });
  });

  it("accepts friendly github/gitlab-style subdomains", () => {
    expect(parseSrvUsLine("https://my-user.srv.us/")).toEqual({
      kind: "connected",
      url: "https://my-user.srv.us",
    });
  });

  it("strips a trailing slash", () => {
    expect(parseSrvUsLine("https://abc.srv.us/")).toEqual({
      kind: "connected",
      url: "https://abc.srv.us",
    });
  });

  it("treats non-URL output as a starting/progress message", () => {
    expect(
      parseSrvUsLine("Warning: Permanently added 'srv.us' to known hosts."),
    ).toEqual({
      kind: "starting",
      message: "Warning: Permanently added 'srv.us' to known hosts.",
    });
  });

  it("returns null for blank lines", () => {
    expect(parseSrvUsLine("")).toBeNull();
    expect(parseSrvUsLine("   ")).toBeNull();
  });
});

describe("srvUsSshArgs", () => {
  it("builds the reverse-tunnel ssh argv with hardening options", () => {
    expect(srvUsSshArgs(63189, "/home/u/.enpilink/id_ed25519")).toEqual([
      "-i",
      "/home/u/.enpilink/id_ed25519",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "srv.us",
      "-R",
      "1:localhost:63189",
    ]);
  });

  it("passes a Windows spaced home path as a SINGLE argv element after -i", () => {
    // C:\Users\John Doe\... contains a space; cross-spawn handles quoting, so the
    // key path must NOT be manually quoted or split — it stays one argv entry.
    const winKey = "C:\\Users\\John Doe\\.enpilink\\id_ed25519";
    const args = srvUsSshArgs(3001, winKey);
    expect(args[0]).toBe("-i");
    expect(args[1]).toBe(winKey);
    // exactly one element equals the key path (not split on the space)
    expect(args.filter((a) => a === winKey)).toHaveLength(1);
  });
});

describe("wrapSshSpawnErrors", () => {
  function fakeChild(): {
    child: TunnelChildProcess;
    emitError: (err: unknown) => void;
  } {
    let errListener: ((err: unknown) => void) | undefined;
    const child: TunnelChildProcess = {
      stdout: null,
      stderr: null,
      kill: () => true,
      on(event: string, listener: (arg: never) => void) {
        if (event === "error") {
          errListener = listener as (err: unknown) => void;
        }
        return child;
      },
    };
    return { child, emitError: (err) => errListener?.(err) };
  }

  it("rewrites a missing-ssh ENOENT into an actionable win32 message", () => {
    const { child, emitError } = fakeChild();
    const wrapped = wrapSshSpawnErrors(child, "win32");
    const seen: Error[] = [];
    wrapped.on("error", (e) => seen.push(e));
    emitError(Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    expect(seen[0]?.message).toMatch(/OpenSSH client not found.*Optional/s);
  });

  it("rewrites a missing-ssh ENOENT into an actionable POSIX message", () => {
    const { child, emitError } = fakeChild();
    const wrapped = wrapSshSpawnErrors(child, "linux");
    const seen: Error[] = [];
    wrapped.on("error", (e) => seen.push(e));
    emitError(Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    expect(seen[0]?.message).toMatch(/OpenSSH client not found.*openssh/s);
  });

  it("passes non-ENOENT errors through unchanged", () => {
    const { child, emitError } = fakeChild();
    const wrapped = wrapSshSpawnErrors(child, "linux");
    const seen: unknown[] = [];
    wrapped.on("error", (e) => seen.push(e));
    const original = Object.assign(new Error("boom"), { code: "EPIPE" });
    emitError(original);
    expect(seen[0]).toBe(original);
  });
});

describe("srvUsProvider", () => {
  it("is named srv.us and exposes ensure + spawn + parseLine", () => {
    expect(srvUsProvider.name).toBe("srv.us");
    expect(typeof srvUsProvider.ensure).toBe("function");
    expect(typeof srvUsProvider.spawn).toBe("function");
    expect(srvUsProvider.parseLine).toBe(parseSrvUsLine);
  });
});
