# Architecture — @ratio/observability-core

The pure, runtime-agnostic logging discipline: the `Logger` shape, `requestLog` (reqId correlation),
the redaction key set, and `classifyError` (throw → closed taxonomy + type, never the raw message).
No deps, no Node APIs — so both the Node logger (`@ratio/observability`) and the Workers logger
(`@ratio/observability-edge`) depend on it, and neither depends on the other.

- **Role:** library — imported by the two logger packages; never reads `process.env`.
- See `docs/adr/0002-observability.md` for the strategy and `docs/adr/0001-monorepo-layout.md`.
