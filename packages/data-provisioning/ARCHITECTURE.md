# Architecture — @ratio/data-provisioning

onboardStore / deleteStore — a tenant is just rows (tenant + domain + home route + membership), created atomically.

- **Role:** library — imported by apps; never reads `process.env`.
- See `docs/adr/0001-monorepo-layout.md` for the monorepo layout and the no-`process.env`-in-packages rule.
