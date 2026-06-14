import { isAbsolute, relative, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import {
  assertUniqueViewNames,
  type DiscoveredView,
  discoverViewsSync,
  scanViewsSync,
  writeViewsDts,
} from "./scan-views.js";
import { transform as dataLlmTransform } from "./transform-data-llm.js";
import { hasDefaultExport } from "./validate-view.js";

const VIRTUAL_PREFIX = "/_enpilink/view/";
const VIRTUAL_MODULE_PREFIX = "\0enpilink:view:";

/** Options for the {@link enpilink} Vite plugin. */
export interface EnpilinkPluginOptions {
  /** Directory scanned for view modules. Defaults to `"src/views"`. */
  viewsDir?: string;
}

function buildVirtualEntry(viewFilePath: string): string {
  const normalized = viewFilePath.replace(/\\/g, "/");
  return [
    `import { mountView } from "enpilink/web";`,
    `import Component from "${normalized}";`,
    `import { createElement } from "react";`,
    `mountView(createElement(Component));`,
  ].join("\n");
}

function getViewEntryPattern(viewsDir: string): RegExp {
  const escaped = viewsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `${escaped}\\/(?:[^/]+\\.(?:jsx|tsx)|[^/]+\\/index\\.(?:tsx|jsx))(?:\\?.*)?$`,
  );
}

/**
 * Vite plugin that wires a enpilink project's view files into Vite.
 *
 * For each `.tsx` / `.jsx` file in `viewsDir` with a default export, the
 * plugin:
 * - exposes a virtual entry that calls {@link mountView} with the view's
 *   default export,
 * - generates `.enpilink/views.d.ts` to augment {@link ViewNameRegistry} so
 *   {@link ViewName} narrows to the actual view names,
 * - rewrites `<DataLLM>` JSX so the host can extract its content,
 * - warns in dev if a view file is missing a default export.
 *
 * Add it to your `vite.config.ts` alongside `@vitejs/plugin-react`.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import react from "@vitejs/plugin-react";
 * import { enpilink } from "enpilink/vite";
 *
 * export default defineConfig({
 *   plugins: [react(), enpilink({ viewsDir: "src/views" })],
 * });
 * ```
 */
export function enpilink(options?: EnpilinkPluginOptions): Plugin {
  const rawViewsDir = options?.viewsDir ?? "src/views";
  let resolvedViewsDir: string;
  let projectRoot: string;
  let viewMap = new Map<string, DiscoveredView>();
  let viewEntryPattern: RegExp;

  return {
    name: "enpilink",
    enforce: "pre",
    // Read by `enpilink build` to resolve viewsDir before `tsc -b` runs.
    api: { viewsDir: rawViewsDir },

    config(config) {
      projectRoot = config.root || process.cwd();
      resolvedViewsDir = isAbsolute(rawViewsDir)
        ? rawViewsDir
        : resolve(projectRoot, rawViewsDir);
      viewEntryPattern = getViewEntryPattern(resolvedViewsDir);

      const views = discoverViewsSync(resolvedViewsDir);
      viewMap = new Map(views.map((v) => [v.name, v]));
      writeViewsDts(projectRoot, views);

      const input: Record<string, string> = {};
      for (const view of views) {
        input[view.name] = `${VIRTUAL_PREFIX}${view.name}`;
      }

      return {
        base: "/assets",
        // Fixes "Invalid hook call" on createStore by forcing a single
        // copy of React. Under pnpm's isolated node_modules, zustand
        // inside `enpilink` resolves React from enpilink's own
        // dependencies while the host app loads its own copy
        resolve: {
          dedupe: ["react", "react-dom"],
        },
        build: {
          outDir: "dist/assets",
          emptyOutDir: true,
          manifest: true,
          minify: true,
          cssCodeSplit: false,
          rollupOptions: {
            input,
          },
        },
        // Pre-bundle view deps at startup so the first tool invocation
        // doesn't hit Vite's on-demand re-optimization path (which sends
        // `full-reload` over HMR — in our iframe flow the parent host
        // can't honour a reload, and the view silently never mounts).
        optimizeDeps: {
          // Scan view files so transitive user deps (zod, tailwind, etc.)
          // get pre-bundled at startup.
          entries: [
            `${resolvedViewsDir}/*.{tsx,jsx}`,
            `${resolvedViewsDir}/*/index.{tsx,jsx}`,
          ],
          include: ["react", "react-dom/client", "react/jsx-runtime"],
          exclude: ["enpilink/web"],
        },
        experimental: {
          renderBuiltUrl: (filename) => {
            return {
              runtime: `window.enpilink.serverUrl + "/assets/${filename}"`,
            };
          },
        },
      };
    },

    resolveId(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        const name = id.slice(VIRTUAL_PREFIX.length);
        if (viewMap.has(name)) {
          return `${VIRTUAL_MODULE_PREFIX}${name}`;
        }
      }
      return null;
    },

    load(id) {
      if (id.startsWith(VIRTUAL_MODULE_PREFIX)) {
        const name = id.slice(VIRTUAL_MODULE_PREFIX.length);
        const view = viewMap.get(name);
        if (view) {
          return buildVirtualEntry(view.filePath);
        }
      }
      return null;
    },

    configureServer(server: ViteDevServer) {
      if (!resolvedViewsDir) {
        const root = server.config.root || process.cwd();
        resolvedViewsDir = isAbsolute(rawViewsDir)
          ? rawViewsDir
          : resolve(root, rawViewsDir);
        projectRoot = root;
        viewEntryPattern = getViewEntryPattern(resolvedViewsDir);
      }

      server.watcher.add(resolvedViewsDir);
      // Track which view files we've already warned about so a rescan
      // triggered by an unrelated edit doesn't re-emit the same warning.
      let knownInvalid = new Set<string>();
      const rescan = () => {
        try {
          // Surface broken view files. Without this, files lacking a
          // default export are silently dropped from the input and the
          // user has no idea why their widget never mounts.
          const { valid, invalid } = scanViewsSync(resolvedViewsDir);
          const nextInvalid = new Set(invalid.map((v) => v.filePath));

          for (const filePath of nextInvalid) {
            if (!knownInvalid.has(filePath)) {
              server.config.logger.warn(
                `[enpilink] view file "${relative(projectRoot, filePath)}" is missing a default export — it won't be served until fixed.`,
              );
            }
          }
          for (const filePath of knownInvalid) {
            if (!nextInvalid.has(filePath)) {
              server.config.logger.info(
                `[enpilink] view file "${relative(projectRoot, filePath)}" resolved.`,
              );
            }
          }
          knownInvalid = nextInvalid;

          assertUniqueViewNames(valid);
          viewMap = new Map(valid.map((v) => [v.name, v]));
          writeViewsDts(projectRoot, valid);
        } catch (err) {
          // assertUniqueViewNames throws on duplicate view names. Catch so
          // chokidar's listener chain doesn't surface it as unhandled and
          // crash the dev server — previous viewMap stays active until
          // the user fixes the conflict.
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(
            `[enpilink] view rescan failed: ${message}`,
          );
        }
      };

      // Initial scan emits warnings for broken files that exist at startup.
      rescan();
      server.watcher.on("add", rescan);
      server.watcher.on("change", rescan);
      server.watcher.on("unlink", rescan);
    },

    async transform(code, id) {
      if (viewEntryPattern?.test(id) && !hasDefaultExport(code, id)) {
        this.warn(
          `View file "${id.split("/").pop()}" is missing a default export.`,
        );
      }

      return await dataLlmTransform(code, id);
    },
  };
}
