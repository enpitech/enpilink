import { Command } from "@oclif/core";
import { resolveViewsDir } from "../cli/resolve-views-dir.js";
import {
  scanAndWriteViewsDts,
  writeViewsDts,
} from "../web/plugin/scan-views.js";

export default class Codegen extends Command {
  static override description =
    "Regenerate view/tool type declarations (.enpilink/views.d.ts) without a full build";
  static override examples = ["enpilink codegen"];

  public async run(): Promise<void> {
    const root = process.cwd();

    let viewsDir: string | undefined;
    try {
      viewsDir = await resolveViewsDir(root);
    } catch {
      // A missing/broken vite config must not stop codegen — fall back to the
      // default views dir so a fresh project still gets a valid declaration.
      viewsDir = undefined;
    }

    try {
      // Generates `.enpilink/views.d.ts` (creating `.enpilink/` if missing).
      // With zero views this still emits a valid, empty `ViewNameRegistry`.
      scanAndWriteViewsDts(root, viewsDir);
    } catch (error) {
      // Never fail a fresh/clean project: still emit a valid empty registry so
      // `tsc --noEmit` can run. A genuine problem (e.g. duplicate view names)
      // is surfaced as a warning, not a hard crash.
      writeViewsDts(root, []);
      const message = error instanceof Error ? error.message : String(error);
      this.warn(
        `Could not scan views (${message}). Wrote an empty type registry.`,
      );
    }

    this.log("✓ Generated .enpilink/views.d.ts");
  }
}
