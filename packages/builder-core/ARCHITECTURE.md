# Architecture — @ratio/builder-core

Page-builder core: the PageDoc model, route matcher, compose, theme tokens, and the config-not-data binding resolver.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
