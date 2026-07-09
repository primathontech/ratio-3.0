# S2 + S1 POC — Multi-tenancy, Routing & Cacheability

Proves the risky parts of **S2** (tenancy/routing) and **S1** (cacheability) actually work,
on one shared host with real Postgres. Everything is keyed by `tenant_id`; the "edge" resolves
`hostname → tenantId` and caches; the private "origin" trusts only the edge header.

## What it proves
**S2** — 1) two tenants on one host · 2) spoof-proof resolution · 3) private origin (403 without edge auth) ·
4) tenant isolation (A can't read B; no-tenant query throws; cross-tenant path → 404) · 5) data-driven routing (new route = a DB row, no rebuild).
**S1** — edge cache with per-page-class tiers · cache HIT never touches origin · exact surrogate-key purge on publish · per-tenant cache key · measured cache-hit ratio + origin-render count.

## Run (two terminals)

**DB** — this repo's `.env` points at a local Postgres DB `s2poc` on :5432 (already created here).
If starting fresh with Docker instead:
```bash
npm install
npm run db:up          # docker postgres on :5433  (then set .env DATABASE_URL to :5433/poc)
npm run db:init        # schema + seed  (needs local psql)
```
Or, using a local Postgres you already run (what the .env expects):
```bash
createdb s2poc
psql postgres://localhost:5432/s2poc -f db/schema.sql -f db/seed.sql
```

**Terminal 1 — start the servers (leave running):**
```bash
npm start              # edge :8080  +  origin :9090
```

**Terminal 2 — run the proofs:**
```bash
npm run prove          # S2  — expect ALL GREEN
npm run prove:s1       # S1  — expect ALL GREEN
```
> Run them separately (not `prove + prove:s1` — the `+` is literal).
> `ECONNREFUSED 127.0.0.1:8080` just means the servers in Terminal 1 aren't running.

Manual poke:
```bash
curl -s localhost:8080/ -H 'Host: acme.localhost'
curl -s localhost:8080/ -H 'Host: beta.localhost'
curl -si localhost:8080/products/red-shoe -H 'Host: acme.localhost' | grep -i x-edge   # MISS then HIT
```

## Map to the design
edge.js = CDN/edge (resolution + cache) · origin.js = shared stateless host (ADR-002) ·
repo.js = tenant-scoped repository / one gate (ADR-001 D-MT3) · routes table = data-driven routing (ADR-002 D-HR3) ·
cache + surrogate purge (ADR-005 D-CDN3/4).
Simulated/out of scope: real CDN vendor, private-network transport, cells, secrets manager, multi-region.
