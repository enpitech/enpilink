// Best-effort SSH key bootstrap for the srv.us tunnel.
//
// Runs on `npm/pnpm install` of enpilink. Generates ~/.enpilink/id_ed25519 if
// missing so `enpilink dev --tunnel` works first try with a stable srv.us URL.
//
// MUST NEVER fail the install: every failure path is swallowed (offline, no
// ssh-keygen, read-only home, CI sandbox, etc.). The provider also calls
// ensureSshKey() lazily at connect time, so this is purely an optimization.
//
// Kept dependency-free and standalone (no TS import) since dist may not be built
// at install time. Mirrors src/cli/ensure-ssh-key.ts.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

try {
  const dir = join(homedir(), ".enpilink");
  const keyPath = join(dir, "id_ed25519");

  if (existsSync(keyPath)) {
    process.exit(0);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const result = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "enpilink"],
    { stdio: "ignore" },
  );

  if (result.status === 0) {
    if (process.platform === "win32") {
      // Windows OpenSSH ignores POSIX perms and rejects keys with open ACLs
      // ("UNPROTECTED PRIVATE KEY FILE"). Lock the ACLs to the current user.
      // Best-effort here; the provider re-locks lazily before connecting.
      try {
        spawnSync(
          "icacls",
          [keyPath, "/inheritance:r", "/grant:r", `${userInfo().username}:F`],
          { stdio: "ignore" },
        );
      } catch {
        // ignore
      }
    } else {
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        // ignore
      }
    }
  }
} catch {
  // best-effort: never fail install
}

process.exit(0);
