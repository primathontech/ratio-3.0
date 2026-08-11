# Architecture — @ratio/observability

Centralized logging (and, later, traces/metrics) for the whole system: `pino` for the Node apps
(`.`), a Workers-safe `console.log(JSON)` logger for the edge (`./edge`), and the shared, pure
conventions both use (`./core` — the Logger shape, redaction, `classifyError`). One discipline,
runtime-appropriate sink. Apps define their own domain events on top; the package owns the foundation.

- **Role:** library — imported by apps; never reads `process.env` (the app injects `level`).
- **Edge exception:** pino needs Node APIs; a Cloudflare Worker imports `@ratio/observability/edge`,
  which shares the field conventions but not the implementation.
- See `docs/adr/0002-observability.md` for the strategy and `docs/adr/0001-monorepo-layout.md` for the
  no-`process.env`-in-packages rule.
