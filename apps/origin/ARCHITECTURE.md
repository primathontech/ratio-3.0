# Architecture — @ratio/origin

Data-plane origin (Hono): router → page-builder render → resolver, behind the private edge link.

- **Role:** deployable app — the composition root; reads env once and injects config into libraries.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
