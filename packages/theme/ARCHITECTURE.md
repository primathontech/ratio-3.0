# Architecture — @ratio/theme

Shared, dependency-free HTML helpers for the page-builder render path: `esc` (HTML escaping) and `safeRichText` (sanitises authored richText). Pure + isomorphic (Worker + container).

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
