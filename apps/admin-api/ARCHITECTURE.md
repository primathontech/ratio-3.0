# Architecture — @ratio/admin-api

Control-plane API (Hono): auth, content + page-builder CRUD, domains, commerce webhook.

- **Role:** deployable app — the composition root; reads env once and injects config into libraries.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
