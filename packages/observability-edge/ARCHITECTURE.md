# Architecture — @ratio/observability-edge

A Workers-safe logger for Cloudflare edge workers: a tiny `console.log(JSON)` sink emitting the SAME
shape/levels/redaction as the Node logger, using the shared conventions from `@ratio/observability-core`.
pino can't run on Workers, so this exists as its own package with **no Node deps** — an edge worker
imports it and cannot accidentally pull pino.

- **Role:** library — imported by edge workers; never reads `process.env`.
- Depends only on `@ratio/observability-core` (pure). Bundles clean into a Worker (verified via
  `wrangler deploy --dry-run`).
- See `docs/adr/0002-observability.md` and `docs/adr/0001-monorepo-layout.md`.
