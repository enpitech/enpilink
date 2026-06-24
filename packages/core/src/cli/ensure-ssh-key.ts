import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Path to enpilink's SSH private key. srv.us derives a stable public URL from
 * this key, so it lives in a fixed, per-user location.
 */
export function sshKeyPath(): string {
  return join(homedir(), ".enpilink", "id_ed25519");
}

/**
 * Actionable message for a missing OpenSSH binary (`ssh` / `ssh-keygen`).
 * Windows ships OpenSSH as an optional feature; POSIX systems install a package.
 */
export function opensshMissingMessage(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `OpenSSH client not found ("${binary}"). Enable it via Settings → Apps → Optional features → Add → OpenSSH Client (or install OpenSSH and restart your terminal).`;
  }
  return `OpenSSH client not found ("${binary}"). Install it (e.g. "sudo apt install openssh-client" or your distro's openssh package).`;
}

/** True when a spawn result indicates the binary itself was not found. */
function isEnoent(result: SpawnSyncReturns<unknown>): boolean {
  const err = result.error as NodeJS.ErrnoException | undefined;
  return err?.code === "ENOENT";
}

/**
 * Lock down the private key so the OpenSSH client accepts it.
 *
 *  - **POSIX:** `chmod 0600`. ssh-keygen already creates 0600, but we enforce it
 *    defensively against umask edge cases.
 *  - **win32:** Node's `chmod` does NOT touch Windows ACLs, so OpenSSH rejects
 *    the key with "UNPROTECTED PRIVATE KEY FILE". We instead restrict the ACLs
 *    via `icacls`: disable inheritance and grant ONLY the current user full
 *    control. The user is resolved from `os.userInfo().username` (robust across
 *    domain/local accounts; avoids relying on the `%USERNAME%` env var).
 *
 * Best-effort: failures are swallowed on POSIX (ssh surfaces a clear error
 * anyway). On win32 a failed ACL lock is the #1 confusing blocker, so we throw a
 * clear hint instead of letting ssh emit "UNPROTECTED PRIVATE KEY FILE".
 */
export function lockPrivateKey(
  keyPath: string,
  options: { platform?: NodeJS.Platform; spawn?: typeof spawnSync } = {},
): void {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnSync;

  if (platform === "win32") {
    const username = userInfo().username;
    const result = spawn(
      "icacls",
      [keyPath, "/inheritance:r", "/grant:r", `${username}:F`],
      { stdio: "ignore" },
    );
    if (isEnoent(result) || result.error || result.status !== 0) {
      throw new Error(
        `Failed to restrict ACLs on the SSH key "${keyPath}" via icacls` +
          `${result.status != null ? ` (exit code ${result.status})` : ""}. ` +
          "Windows OpenSSH will reject a key with open permissions " +
          '("UNPROTECTED PRIVATE KEY FILE"). Manually run: ' +
          `icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:F"`,
      );
    }
    return;
  }

  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort; ssh will still refuse a too-open key and surface a clear error
  }
}

/**
 * Ensure an ed25519 SSH key exists at `~/.enpilink/id_ed25519`, generating one
 * non-interactively if missing. Returns the key path.
 *
 * Idempotent: a no-op when the key already exists. Used (a) lazily inside the
 * srv.us provider before connecting and (b) from the package postinstall script
 * (best-effort — see scripts/postinstall.mjs).
 *
 * On Windows the freshly generated key's ACLs are locked to the current user via
 * `icacls` (Node's `chmod` does not set Windows ACLs); on POSIX it is `chmod`ed
 * to 0600. See {@link lockPrivateKey}.
 *
 * The `options` arg exists for testability (inject platform / a fake spawn) and
 * defaults to the real platform + `spawnSync`, so existing callers are unchanged.
 *
 * @throws if `ssh-keygen` is missing (with an actionable, platform-specific
 *   message) or key generation/locking fails. Callers that must never fail
 *   (postinstall) should swallow the error.
 */
export function ensureSshKey(
  options: { platform?: NodeJS.Platform; spawn?: typeof spawnSync } = {},
): string {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnSync;
  const keyPath = sshKeyPath();
  if (existsSync(keyPath)) {
    return keyPath;
  }

  mkdirSync(join(homedir(), ".enpilink"), { recursive: true, mode: 0o700 });

  const result = spawn(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "enpilink"],
    { stdio: "ignore" },
  );

  if (isEnoent(result)) {
    throw new Error(opensshMissingMessage("ssh-keygen", platform));
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `ssh-keygen exited with code ${result.status ?? "unknown"}`,
    );
  }

  lockPrivateKey(keyPath, { platform, spawn });

  return keyPath;
}
