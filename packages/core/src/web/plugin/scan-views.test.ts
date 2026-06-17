import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverViewsSync,
  generateViewsDts,
  scanAndWriteViewsDts,
  scanViewsSync,
  writeViewsDts,
} from "./scan-views.js";

const DEFAULT_EXPORT = "export default function V() { return null; }";

describe("discoverViewsSync", () => {
  let root: string;
  let viewsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "enpilink-scan-"));
    viewsDir = join(root, "views");
    mkdirSync(viewsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("picks up flat and dir-index views", () => {
    writeFileSync(join(viewsDir, "a.tsx"), DEFAULT_EXPORT);
    mkdirSync(join(viewsDir, "my-view"));
    writeFileSync(join(viewsDir, "my-view/index.tsx"), DEFAULT_EXPORT);

    expect(
      discoverViewsSync(viewsDir)
        .map((v) => v.name)
        .sort(),
    ).toEqual(["a", "my-view"]);
  });

  it("throws on duplicate view names (flat + dir-index collision)", () => {
    writeFileSync(join(viewsDir, "dup.tsx"), DEFAULT_EXPORT);
    mkdirSync(join(viewsDir, "dup"));
    writeFileSync(join(viewsDir, "dup/index.tsx"), DEFAULT_EXPORT);

    expect(() => discoverViewsSync(viewsDir)).toThrow(
      /duplicate view name "dup"/,
    );
  });
});

describe("scanViewsSync", () => {
  let root: string;
  let viewsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "enpilink-scan-views-"));
    viewsDir = join(root, "views");
    mkdirSync(viewsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns valid and invalid views from a flat layout", () => {
    writeFileSync(join(viewsDir, "ok.tsx"), DEFAULT_EXPORT);
    writeFileSync(
      join(viewsDir, "broken.tsx"),
      "export const Foo = () => null;",
    );

    const { valid, invalid } = scanViewsSync(viewsDir);

    expect(valid.map((v) => v.name).sort()).toEqual(["ok"]);
    expect(invalid).toEqual([{ filePath: join(viewsDir, "broken.tsx") }]);
  });

  it("flags an index file in a view dir that lacks a default export", () => {
    mkdirSync(join(viewsDir, "broken"));
    writeFileSync(
      join(viewsDir, "broken/index.tsx"),
      "export const Foo = () => null;",
    );

    const { valid, invalid } = scanViewsSync(viewsDir);

    expect(valid).toEqual([]);
    expect(invalid).toEqual([{ filePath: join(viewsDir, "broken/index.tsx") }]);
  });

  it("ignores top-level index.tsx (treated as a barrel, not a view)", () => {
    writeFileSync(
      join(viewsDir, "index.tsx"),
      "export const Foo = () => null;",
    );

    const { valid, invalid } = scanViewsSync(viewsDir);

    expect(valid).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

describe("writeViewsDts", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "enpilink-dts-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op when content is unchanged", () => {
    const views = [{ name: "a", filePath: "/a.tsx" }];
    writeViewsDts(root, views);

    const dtsPath = join(root, ".enpilink", "views.d.ts");
    const firstMtime = statSync(dtsPath).mtimeMs;

    writeViewsDts(root, views);
    expect(statSync(dtsPath).mtimeMs).toBe(firstMtime);
  });
});

describe("scanAndWriteViewsDts", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "enpilink-scan-dts-"));
    mkdirSync(join(root, "src/views"), { recursive: true });
    writeFileSync(join(root, "src/views/hello.tsx"), DEFAULT_EXPORT);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a views.d.ts that augments enpilink/server with discovered view names", () => {
    scanAndWriteViewsDts(root);

    const content = readFileSync(join(root, ".enpilink/views.d.ts"), "utf-8");
    expect(content).toContain('declare module "enpilink/server"');
    expect(content).toContain('"hello": true;');
  });

  it("creates the .enpilink dir and emits a valid empty registry for zero views (fresh project)", () => {
    const empty = mkdtempSync(join(tmpdir(), "enpilink-empty-"));
    mkdirSync(join(empty, "src/views"), { recursive: true });
    try {
      // No view files at all — must still succeed and create the artifact.
      scanAndWriteViewsDts(empty);

      const content = readFileSync(
        join(empty, ".enpilink/views.d.ts"),
        "utf-8",
      );
      expect(content).toBe(generateViewsDts([]));
      expect(content).toContain("interface ViewNameRegistry");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("generateViewsDts", () => {
  it("emits a valid (empty) ViewNameRegistry for zero views", () => {
    const out = generateViewsDts([]);
    expect(out).toContain('declare module "enpilink/server"');
    expect(out).toContain("interface ViewNameRegistry {");
    expect(out).not.toMatch(/": true;/);
  });

  it("declares each discovered view name", () => {
    const out = generateViewsDts([
      { name: "checkout", filePath: "/x/checkout.tsx" },
      { name: "product", filePath: "/x/product.tsx" },
    ]);
    expect(out).toContain('"checkout": true;');
    expect(out).toContain('"product": true;');
  });

  it("is deterministic — sorts view names regardless of input order", () => {
    const ordered = generateViewsDts([
      { name: "alpha", filePath: "/x/alpha.tsx" },
      { name: "beta", filePath: "/x/beta.tsx" },
      { name: "gamma", filePath: "/x/gamma.tsx" },
    ]);
    const shuffled = generateViewsDts([
      { name: "gamma", filePath: "/x/gamma.tsx" },
      { name: "alpha", filePath: "/x/alpha.tsx" },
      { name: "beta", filePath: "/x/beta.tsx" },
    ]);
    expect(shuffled).toBe(ordered);
    expect(ordered.indexOf("alpha")).toBeLessThan(ordered.indexOf("beta"));
    expect(ordered.indexOf("beta")).toBeLessThan(ordered.indexOf("gamma"));
  });
});
