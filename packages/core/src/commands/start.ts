import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Flags } from "@oclif/core";
import { resolvePort } from "../cli/detect-port.js";
import { runCommand } from "../cli/run-command.js";

export default class Start extends Command {
  static override description = "Start production server";
  static override examples = ["enpilink start"];
  static override flags = {
    port: Flags.integer({
      char: "p",
      description: "Port to run the server on",
      min: 1,
    }),
    admin: Flags.boolean({
      description:
        "Enable the production admin plane (dashboard + config + observability API) behind bearer auth. OFF by default. Requires ENPILINK_ADMIN_TOKEN to be set — the server refuses to start without it.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Start);
    const { port, fallback, envWarning } = await resolvePort(flags.port);
    if (envWarning) {
      this.warn(envWarning);
    }

    console.clear();

    // `dist/server.js` is the natural entry (the user's `await server.run()`
    // binds the port). Prefer `dist/__entry.js` when present because it
    // primes the Vite manifest first — without it, hashed asset URLs in
    // views won't resolve.
    const entryPath = resolve(process.cwd(), "dist/__entry.js");
    const fallbackPath = resolve(process.cwd(), "dist/server.js");
    const indexPath = existsSync(entryPath) ? entryPath : fallbackPath;

    if (!existsSync(indexPath)) {
      console.error("❌ Error: No build output found");
      console.error("");
      console.error("Please build your project first:");
      console.error("  enpilink build");
      console.error("");
      process.exit(1);
    }

    console.log(
      `\x1b[36m\x1b[1m⛰ enpilink\x1b[0m \x1b[36mv${this.config.version}\x1b[0m`,
    );
    if (fallback) {
      console.log(
        `\x1b[33m3000 in use, running on\x1b[0m \x1b[32mhttp://localhost:${port}/mcp\x1b[0m`,
      );
    } else {
      console.log(`Running on \x1b[32mhttp://localhost:${port}/mcp\x1b[0m`);
    }

    // `--admin` opts into the prod admin plane; it's also enableable purely via
    // `ENPILINK_ADMIN`. Either way the spawned server reads `ENPILINK_ADMIN` +
    // `ENPILINK_ADMIN_TOKEN` and refuses to start without a token.
    const adminEnabled =
      flags.admin ||
      ["1", "true", "yes", "on"].includes(
        (process.env.ENPILINK_ADMIN ?? "").trim().toLowerCase(),
      );
    if (adminEnabled) {
      const hasToken = (process.env.ENPILINK_ADMIN_TOKEN ?? "").trim() !== "";
      if (!hasToken) {
        console.error("");
        console.error(
          "❌ Error: --admin requires ENPILINK_ADMIN_TOKEN to be set",
        );
        console.error(
          "   Set a non-empty admin token, e.g. ENPILINK_ADMIN_TOKEN=… enpilink start --admin",
        );
        console.error("   Refusing to start an unauthenticated admin plane.");
        process.exit(1);
      }
      console.log(
        `Admin plane on \x1b[32mhttp://localhost:${port}/\x1b[0m \x1b[2m(behind bearer auth — send Authorization: Bearer <ENPILINK_ADMIN_TOKEN>)\x1b[0m`,
      );
    }

    await runCommand(`node ${indexPath}`, {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        __PORT: String(port),
        ...(flags.admin ? { ENPILINK_ADMIN: "1" } : {}),
      },
    });
  }
}
