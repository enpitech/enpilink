import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  spawnSync: vi.fn(),
  homedir: vi.fn(() => "/home/tester"),
  userInfo: vi.fn(() => ({ username: "tester" })),
}));

vi.mock("node:fs", () => {
  const fs = {
    existsSync: mocks.existsSync,
    mkdirSync: mocks.mkdirSync,
    chmodSync: mocks.chmodSync,
  };
  return { ...fs, default: fs };
});
vi.mock("node:os", () => {
  const os = { homedir: mocks.homedir, userInfo: mocks.userInfo };
  return { ...os, default: os };
});
vi.mock("node:child_process", () => {
  const cp = { spawnSync: mocks.spawnSync };
  return { ...cp, default: cp };
});

import {
  ensureSshKey,
  lockPrivateKey,
  opensshMissingMessage,
  sshKeyPath,
} from "./ensure-ssh-key.js";

const KEY = "/home/tester/.enpilink/id_ed25519";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("sshKeyPath", () => {
  it("points at ~/.enpilink/id_ed25519", () => {
    expect(sshKeyPath()).toBe(KEY);
  });
});

describe("ensureSshKey", () => {
  it("is a no-op when the key already exists", () => {
    mocks.existsSync.mockReturnValue(true);
    expect(ensureSshKey()).toBe(KEY);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
  });

  it("generates an ed25519 key non-interactively when missing", () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });

    expect(ensureSshKey({ platform: "linux" })).toBe(KEY);

    expect(mocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.enpilink", {
      recursive: true,
      mode: 0o700,
    });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", KEY, "-C", "enpilink"],
      { stdio: "ignore" },
    );
  });

  it("on POSIX chmods 0600 and does NOT call icacls", () => {
    mocks.existsSync.mockReturnValue(false);
    // ssh-keygen succeeds; any icacls call would also resolve, so assert by args.
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });

    ensureSshKey({ platform: "linux" });

    expect(mocks.chmodSync).toHaveBeenCalledWith(KEY, 0o600);
    expect(mocks.spawnSync).not.toHaveBeenCalledWith(
      "icacls",
      expect.anything(),
      expect.anything(),
    );
  });

  it("on win32 locks ACLs via icacls and does NOT chmod", () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.userInfo.mockReturnValue({ username: "John Doe" });
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });

    ensureSshKey({ platform: "win32" });

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "icacls",
      [KEY, "/inheritance:r", "/grant:r", "John Doe:F"],
      { stdio: "ignore" },
    );
    expect(mocks.chmodSync).not.toHaveBeenCalled();
  });

  it("on win32 surfaces a clear hint when icacls fails", () => {
    mocks.existsSync.mockReturnValue(false);
    // First call (ssh-keygen) ok; second call (icacls) fails.
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, error: undefined })
      .mockReturnValueOnce({ status: 1, error: undefined });

    expect(() => ensureSshKey({ platform: "win32" })).toThrow(
      /icacls|UNPROTECTED PRIVATE KEY FILE/,
    );
  });

  it("throws an actionable POSIX message when ssh-keygen is missing (ENOENT)", () => {
    mocks.existsSync.mockReturnValue(false);
    const err = Object.assign(new Error("spawn ssh-keygen ENOENT"), {
      code: "ENOENT",
    });
    mocks.spawnSync.mockReturnValue({ status: null, error: err });
    expect(() => ensureSshKey({ platform: "linux" })).toThrow(
      /OpenSSH client not found.*openssh/s,
    );
  });

  it("throws an actionable win32 message when ssh-keygen is missing (ENOENT)", () => {
    mocks.existsSync.mockReturnValue(false);
    const err = Object.assign(new Error("spawn ssh-keygen ENOENT"), {
      code: "ENOENT",
    });
    mocks.spawnSync.mockReturnValue({ status: null, error: err });
    expect(() => ensureSshKey({ platform: "win32" })).toThrow(
      /OpenSSH client not found.*Optional features.*OpenSSH Client/s,
    );
  });

  it("throws when ssh-keygen exits non-zero", () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.spawnSync.mockReturnValue({ status: 1, error: undefined });
    expect(() => ensureSshKey({ platform: "linux" })).toThrow(/code 1/);
  });
});

describe("lockPrivateKey", () => {
  it("chmods 0600 on POSIX with an injected spawn", () => {
    const spawn = vi.fn();
    lockPrivateKey(KEY, { platform: "darwin", spawn });
    expect(mocks.chmodSync).toHaveBeenCalledWith(KEY, 0o600);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs icacls with the current username on win32 (spaced path safe)", () => {
    const spaced = "C:\\Users\\John Doe\\.enpilink\\id_ed25519";
    const spawn = vi.fn().mockReturnValue({ status: 0, error: undefined });
    mocks.userInfo.mockReturnValue({ username: "John Doe" });
    lockPrivateKey(spaced, { platform: "win32", spawn });
    // The spaced path must be a SINGLE argv element (no manual quoting).
    expect(spawn).toHaveBeenCalledWith(
      "icacls",
      [spaced, "/inheritance:r", "/grant:r", "John Doe:F"],
      { stdio: "ignore" },
    );
  });

  it("throws on win32 when icacls reports ENOENT", () => {
    const spawn = vi.fn().mockReturnValue({
      status: null,
      error: Object.assign(new Error("spawn icacls ENOENT"), {
        code: "ENOENT",
      }),
    });
    expect(() => lockPrivateKey(KEY, { platform: "win32", spawn })).toThrow(
      /icacls/,
    );
  });
});

describe("opensshMissingMessage", () => {
  it("gives Windows-specific guidance on win32", () => {
    expect(opensshMissingMessage("ssh", "win32")).toMatch(
      /Optional features.*OpenSSH Client/s,
    );
  });
  it("gives package-install guidance on POSIX", () => {
    expect(opensshMissingMessage("ssh", "linux")).toMatch(/openssh/);
  });
});
