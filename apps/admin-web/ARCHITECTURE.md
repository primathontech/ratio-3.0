# Architecture — @ratio/admin-web

Admin SPA (React + Vite): store onboarding, page builder, theme settings, domains.

- **Role:** deployable app — the composition root; reads env once and injects config into libraries.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
