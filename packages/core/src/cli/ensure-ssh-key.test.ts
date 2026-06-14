import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  spawnSync: vi.fn(),
  homedir: vi.fn(() => "/home/tester"),
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
  const os = { homedir: mocks.homedir };
  return { ...os, default: os };
});
vi.mock("node:child_process", () => {
  const cp = { spawnSync: mocks.spawnSync };
  return { ...cp, default: cp };
});

import { ensureSshKey, sshKeyPath } from "./ensure-ssh-key.js";

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

    expect(ensureSshKey()).toBe(KEY);

    expect(mocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.enpilink", {
      recursive: true,
      mode: 0o700,
    });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", KEY, "-C", "enpilink"],
      { stdio: "ignore" },
    );
    expect(mocks.chmodSync).toHaveBeenCalledWith(KEY, 0o600);
  });

  it("throws when ssh-keygen is unavailable (spawn error)", () => {
    mocks.existsSync.mockReturnValue(false);
    const err = new Error("spawn ssh-keygen ENOENT");
    mocks.spawnSync.mockReturnValue({ status: null, error: err });
    expect(() => ensureSshKey()).toThrow("ENOENT");
  });

  it("throws when ssh-keygen exits non-zero", () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.spawnSync.mockReturnValue({ status: 1, error: undefined });
    expect(() => ensureSshKey()).toThrow(/code 1/);
  });
});
