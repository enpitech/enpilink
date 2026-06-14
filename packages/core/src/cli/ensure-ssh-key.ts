import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Path to enpilink's SSH private key. srv.us derives a stable public URL from
 * this key, so it lives in a fixed, per-user location.
 */
export function sshKeyPath(): string {
  return join(homedir(), ".enpilink", "id_ed25519");
}

/**
 * Ensure an ed25519 SSH key exists at `~/.enpilink/id_ed25519`, generating one
 * non-interactively if missing. Returns the key path.
 *
 * Idempotent: a no-op when the key already exists. Used (a) lazily inside the
 * srv.us provider before connecting and (b) from the package postinstall script
 * (best-effort — see scripts/postinstall.mjs).
 *
 * @throws if key generation fails (e.g. `ssh-keygen` unavailable). Callers that
 *   must never fail (postinstall) should swallow the error.
 */
export function ensureSshKey(): string {
  const keyPath = sshKeyPath();
  if (existsSync(keyPath)) {
    return keyPath;
  }

  mkdirSync(join(homedir(), ".enpilink"), { recursive: true, mode: 0o700 });

  const result = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "enpilink"],
    { stdio: "ignore" },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `ssh-keygen exited with code ${result.status ?? "unknown"}`,
    );
  }

  // ssh-keygen already creates 0600, but enforce it defensively (umask edge cases).
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort; ssh will still refuse a too-open key and surface a clear error
  }

  return keyPath;
}
