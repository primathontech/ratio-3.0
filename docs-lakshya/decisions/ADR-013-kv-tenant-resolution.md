# ADR-013 — Edge tenant resolution via Workers KV, fail-closed (v3)

> Status: **Proposed (v3)** · first draft 2026-07-15; rewritten 2026-07-16 after two review
> rounds (v1 "DB becomes fallback" superseded — layered amendments replaced by this rewrite).
> Feeds: S2 (routing), S3 (resilience), ADR-008. Companion: `specs/02` v3.

## Problem

ratio-3.0's Worker resolves `host → tenant` with a Postgres query on every request — including
cache hits. Vendor-independent topology flaw: DB down = every storefront down (Layer-1 SPOF
reinstated), and every request pays an edge→DB round trip out of the TTFB budget. A DB fallback
on KV miss (v1's design) additionally exposes an attacker-controlled hot path: unique-hostname
spraying drives unbounded DB load, and a suspended tenant's mapping can repopulate itself.

## Decision

**Workers KV is the only public-path source for tenant resolution. There is no DB fallback on
the public path. Unknown host = 404, fail-closed.**

1. **Key/value:** `host:{host}` → status-tagged JSON, atomic single read:
   - `{ status: 'active', tenantId, current, previous }` — `current`/`previous` are the tenant's
     release pointers (spec 02 §1), folded in so the edge does **one KV read per request**.
   - `{ status: 'suspended' }` — serve 404 (don't reveal existence).
   - key absent — serve 404. Never query the DB.
2. **Writes (control plane only):**
   - **Provisioning writes KV before DNS exists** — every legitimate host is in KV before it can
     receive traffic.
   - **Migration pre-seeds** all existing domains via bulk KV write. No lazy population.
   - **Publish** rewrites the tenant's host keys with the new `{current, previous}` (serialized
     per-tenant publisher, after the R2 activation barrier — spec 02 §1).
   - **Suspend/domain-removal** overwrites to `{status:'suspended'}` / deletes the key.
3. **Renders pinned to release:** edge forwards `x-ratio-release: current`; origin loads that
   release's manifest — resolution and content version travel together.

## Consequences

- **Resilience:** resolution works with the DB fully down; combined with the R2 release store,
  the read path survives origin + DB death (S3).
- **Latency:** no per-request DB round trip; KV read is edge-local (~sub-ms hot).
- **Security:** hostname spraying hits only KV (flat cost, no amplification); suspended tenants
  cannot self-repopulate (no fallback exists to do it).
- **Eventual consistency (~60s, no hard ceiling):** new domains may 404 at some edges briefly
  (DNS propagation dominates anyway); publish freshness is p99 ≤60s (D25); suspension takes
  effect in ~60–90s (register D4) — accepted and documented.
- **Operational duty:** KV is now authoritative for routing — provisioning/migration bugs mean
  a live domain 404s. Mitigation: reconciliation job diffs KV against the `domains` table and
  alerts (control plane, not request path).
- **Cost:** ~$0 at POC scale; ~$50/mo at 100M req/mo (1 read/request).

## Rejected

- **DB on the hot path** (status quo) — SPOF + latency, fails S3 by construction.
- **DB fallback on KV miss** (v1) — reopens the spray vector and the suspend-repopulation bug;
  negative-caching can't fix it (unique hostnames never repeat; a `null` sentinel re-triggers
  the fallback it guards).
- **Workers Cache API for the mapping** — per-colo, no global replication; wrong primitive.
- **In-isolate memory** — ephemeral, per-PoP, cold too often.
