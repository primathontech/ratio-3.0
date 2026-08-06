# Architecture — @ratio/builder-registry

Section registry: first-party section types, typed editor settings, and island registration.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
