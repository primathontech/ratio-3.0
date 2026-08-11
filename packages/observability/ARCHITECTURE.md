# Architecture — @ratio/observability

Node logging with **pino** for the container apps (origin, admin-api). Emits structured JSON to stdout
using the shared conventions from `@ratio/observability-core`. Apps define their own domain events on
top; this package owns the Node sink + config.

- **Role:** library — imported by the Node apps; never reads `process.env` (the app injects `level`).
- **Edge:** a Cloudflare Worker cannot run pino — it uses `@ratio/observability-edge` instead. This
  package (and its pino dep) is Node-only by construction.
- See `docs/adr/0002-observability.md` and `docs/adr/0001-monorepo-layout.md`.
