# Architecture — @ratio/edge

Cloudflare Worker edge adapter: resolve host→tenant, serve from cache, proxy misses to the origin.

- **Role:** deployable app — the composition root; reads env once and injects config into libraries.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
