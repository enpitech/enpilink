import spawn from "cross-spawn";
import { ensureSshKey } from "../ensure-ssh-key.js";
import type {
  ParsedStdoutEvent,
  TunnelChildProcess,
  TunnelProvider,
} from "./types.js";

/**
 * Matches a srv.us public URL anywhere in a stdout line. srv.us announces each
 * forwarded port as `<n>: https://<hash>.srv.us/` (live-confirmed 2026-06-14),
 * with NO `Forwarding:` prefix — so we scan for the URL itself anywhere in the
 * line. Tolerant of GitHub/GitLab-style friendly subdomains (any host ending in
 * `.srv.us`) and an optional trailing slash.
 */
const SRV_US_URL_RE = /(https?:\/\/[a-z0-9.-]+\.srv\.us)\/?/i;

export function parseSrvUsLine(line: string): ParsedStdoutEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(SRV_US_URL_RE);
  if (match?.[1]) {
    return { kind: "connected", url: match[1].replace(/\/$/, "") };
  }
  return { kind: "starting", message: trimmed };
}

/**
 * Build the ssh argv for a srv.us reverse tunnel.
 *  - `-i <keyPath>`: use enpilink's dedicated key (stable URL).
 *  - `StrictHostKeyChecking=accept-new`: trust srv.us on first connect, no prompt.
 *  - `ServerAliveInterval=30` / `ServerAliveCountMax=3`: detect dead links fast
 *    so auto-reconnect kicks in.
 *  - `ExitOnForwardFailure=yes`: fail (and let us reconnect) instead of hanging
 *    if the remote forward can't be set up.
 *  - `-R 1:localhost:<port>`: reverse-forward srv.us tunnel #1 to the dev server.
 */
export function srvUsSshArgs(port: number, keyPath: string): string[] {
  return [
    "-i",
    keyPath,
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
    `1:localhost:${port}`,
  ];
}

/**
 * The default, account-free provider. Spawns `ssh … srv.us -R 1:localhost:<port>`
 * after lazily ensuring the ed25519 key exists.
 */
export const srvUsProvider: TunnelProvider = {
  name: "srv.us",
  ensure() {
    ensureSshKey();
  },
  spawn(port: number): TunnelChildProcess {
    const keyPath = ensureSshKey();
    return spawn("ssh", srvUsSshArgs(port, keyPath), {
      stdio: ["ignore", "pipe", "pipe"],
    });
  },
  parseLine: parseSrvUsLine,
};
