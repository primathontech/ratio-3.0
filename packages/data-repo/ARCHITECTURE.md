# Architecture — @ratio/data-repo

Tenant-scoped repository — the one gate: every query is keyed by tenant_id.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
