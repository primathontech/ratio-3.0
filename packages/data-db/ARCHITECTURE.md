# Architecture — @ratio/data-db

Postgres connection pool. Reads its connection string from the environment the app hands it — no .env hunting.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
