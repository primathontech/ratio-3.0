# Architecture — @ratio/builder-render

Sandboxed LiquidJS render engine + isolate wall-clock kill + cacheability-tier inference. The untrusted-template security boundary.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
