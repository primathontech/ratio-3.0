# Ratio 3.0

Multi-tenant storefront platform. One shared, stateless host serves every tenant;
a **merchant is data** (rows keyed by `tenant_id`), not a deployment. Adding a store
is inserting rows — no fork, no server, no redeploy.

**Stack:** Cloudflare Workers (edge) → AWS ECS (origin, Hono + `pg`) → Neon (Postgres),
TypeScript. Full architecture, infra, and env/secrets: **[INFRASTRUCTURE.md](./INFRASTRUCTURE.md)**.

## Live

| URL                                                            |                                              |
| -------------------------------------------------------------- | -------------------------------------------- |
| `https://acme.ratiodev.in` · `https://beta.ratiodev.in`        | real host→tenant on platform subdomains      |
| `http://acme.localhost:8787/?store=t_acme`                     | the `?store=` tenant override is dev-only (localhost); it is refused on public hosts |

---

## Onboard a new merchant

A store on a **platform subdomain** (`<merchant>.ratiodev.in`) — **one command**, no code, no deploy.
It creates the tenant in Neon **and** the DNS record in a single run:

```bash
gh workflow run onboard-merchant.yml --repo primathontech/ratio-3.0 \
  -f id=t_zappy -f name="Zappy" -f sub=zappy -f color="#16a085"
```

→ `https://zappy.ratiodev.in` serves the store (allow a few minutes for a brand-new
subdomain's DNS to propagate).

Inputs: `id` = `t_<slug>` · `sub` = subdomain slug · `color` = theme hex · `domain`
defaults to `ratiodev.in`.

> No GitHub CLI? GitHub → **Actions** → _Onboard merchant (one-click)_ → **Run workflow**.
> (Lower-level `onboard.yml` + `cf-setup-domain.yml` still exist for BYO-domain / bulk cases.)

**Merchant's own domain** (e.g. `shop.acme.com`) = Cloudflare-for-SaaS path — currently
on hold (see Jira OFCE-359 / INFRASTRUCTURE.md).

---

## Local development

```bash
cp .env.example .env      # point DATABASE_URL at your local Postgres
npm install
npm run db:init           # run migrations + seed
npm start                 # edge :8080 + origin :9090 (two-server local sim)
npm test                  # node:test against the s2poc_test DB
npm run typecheck && npm run lint
npm run prove             # S2 full-stack proof — expect ALL GREEN
npm run prove:s1          # S1 cacheability proof — expect ALL GREEN
```

Manual poke (local):

```bash
curl -s localhost:8080/ -H 'Host: acme.localhost'
curl -si localhost:8080/products/red-shoe -H 'Host: acme.localhost' | grep -i x-edge   # MISS then HIT
```

## What the proofs cover

- **S2** — two tenants on one host · spoof-proof resolution · private origin (403 without
  edge auth) · tenant isolation (A can't read B; no-tenant query throws; cross-tenant → 404)
  · data-driven routing (new route = a DB row).
- **S1** — per-page-class cache tiers · HIT never touches origin · exact surrogate-key
  purge on publish · per-tenant cache key.

## Layout (control plane / data plane — ADR-014)

```
apps/edge/worker.ts       DATA PLANE — Cloudflare Worker (host→tenant, inject header, proxy)
apps/origin/index.ts      DATA PLANE — Hono app (shared host)
apps/origin/server.ts     DATA PLANE — container entrypoint
apps/admin/               CONTROL PLANE — Ratio merchant dashboard (planned, OFCE-362)
services/admin-api/   CONTROL PLANE — authed onboarding/content API (planned, OFCE-362)
packages/repo/            tenant-scoped repository — the one gate (deny-by-default)
packages/provisioning/    onboardStore() / deleteStore()  (→ moves into services/admin-api)
packages/shared/          db · metrics · ratelimit
dev/                      local two-server simulator (edge-sim + server) — dev only
db/migrations/            schema migrations + runner (scripts/migrate.ts)
.github/workflows/        CI/CD + ops workflows (see INFRASTRUCTURE.md)
```

> Data plane (shopper runtime) is built + live. Control plane (`apps/admin` +
> `services/admin-api`) is the next build — onboarding/editing move there as an
> authenticated product, off the ops workflows.
