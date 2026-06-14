# Deploy

enpilink is **account-free** and not tied to any hosting vendor. `enpilink build`
produces a self-contained bundle you run with plain Node — host it anywhere.

## Parameters

- `{path-to-project}` is the path to the project directory, relative to the current working directory. Verify it's correct before running build/deploy commands.

## Steps

1. **Build for production**

From the project directory, run the build:

```bash
{pm} run build      # runs `enpilink build`
```

This emits `dist/__entry.js` (plus Cloudflare/Vercel artifacts under `dist/` and
`.vercel/`). The build automatically rewrites server `@/…` path aliases, so no
`tsc-alias` step is needed in the project's own scripts.

2. **Run it anywhere that has Node ≥22**

```bash
__PORT=3000 node dist/__entry.js
```

> The production entry reads the **`__PORT`** environment variable (NOT `PORT`),
> defaulting to `3000`. `enpilink start` sets it for you.

Deploy targets:

- **Node host / VM / PaaS** — run `node dist/__entry.js` (or `enpilink start`).
- **Docker** — generated templates include a multi-stage `Dockerfile`:
  `docker build -t my-app . && docker run -p 3000:3000 my-app`.
- **Cloudflare Workers** — add a `wrangler.jsonc` with `nodejs_compat` and
  `npx wrangler deploy`.
- **Vercel** — `npx vercel deploy --prebuilt` (the build emits the Build Output
  API tree under `.vercel/output/`).

3. **Expose it to a host (dev/preview)**

For ad-hoc remote testing, `enpilink dev --tunnel` opens an account-free
[srv.us](https://srv.us) SSH tunnel and prints a public `/mcp` URL — no login,
no signup. The URL is stable across runs (derived from `~/.enpilink/id_ed25519`).

Full docs: [docs.enpitech.dev/quickstart/deploy](https://docs.enpitech.dev/quickstart/deploy)
