# Ratio 3.0

Multi-tenant storefront platform. One shared, stateless host serves every tenant;
a **merchant is data** (rows keyed by `tenant_id`), not a deployment. Adding a store
is inserting rows — no fork, no server, no redeploy.

**Stack:** Cloudflare Workers (edge) → AWS ECS (origin, Hono + `pg`) → Neon (Postgres),
TypeScript. Full architecture, infra, and env/secrets: **[INFRASTRUCTURE.md](./INFRASTRUCTURE.md)**.

## Live

| URL | |
| --- | --- |
| `https://acme.ratiodev.in` · `https://beta.ratiodev.in` | real host→tenant on platform subdomains |
| `https://ratio-3-0.ramvishvas-kumar.workers.dev/?store=t_acme` | Worker on workers.dev (tenant via `?store=`) |

---

## Onboard a new merchant

A store on a **platform subdomain** (`<merchant>.ratiodev.in`) — 2 steps, no code, no deploy.

**1. Create the store (data → Neon):**
```bash
gh workflow run onboard.yml --repo primathontech/ratio-3.0 \
  -f id=t_zappy -f name="Zappy" -f host=zappy.ratiodev.in -f color="#16a085"
```

**2. Give it a subdomain DNS record:**
```bash
gh workflow run cf-setup-domain.yml --repo primathontech/ratio-3.0 \
  -f domain=ratiodev.in -f subs="zappy" -f script=ratio-3-0
```

**3. Done →** `https://zappy.ratiodev.in` serves the store (allow a few minutes for the
new subdomain's DNS to propagate).

Inputs: `id` = `t_<slug>` · `host` = `<slug>.ratiodev.in` · `color` = theme hex.

> No GitHub CLI? Do the same via GitHub → **Actions** → *Onboard merchant* / *CF setup
> domain* → **Run workflow**.

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

## Layout

```
src/edge.ts       local CDN simulator (Cloudflare Worker = src/worker.ts in prod)
src/worker.ts     Cloudflare Worker (edge): host→tenant, inject header, proxy to origin
src/origin.ts     Hono app (shared host); origin-server.ts = container entrypoint
src/repo.ts       tenant-scoped repository — the one gate (deny-by-default)
src/onboard.ts    onboardStore() / deleteStore() (provisioning)
db/migrations/    schema migrations + runner (scripts/migrate.ts)
.github/workflows CI/CD + ops workflows (see INFRASTRUCTURE.md)
```
