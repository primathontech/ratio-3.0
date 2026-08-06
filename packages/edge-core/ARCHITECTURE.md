# Architecture — @ratio/edge-core

Portable edge logic: host→tenant resolve, serve-stale + circuit breaker, header hygiene, access log. Shared by the edge adapter.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
