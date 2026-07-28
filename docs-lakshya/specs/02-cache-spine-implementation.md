# Spec — Cache Spine Implementation in ratio-3.0 (v3.1)

> Status: **Draft v3.1** · 2026-07-16 · v3 + review round 3: ratification test matrix (P1–P16),
> D28 feasibility protocol, E0 read-path experiment, unknown-path rule, retention/GC.
> Companion: `decisions/ADR-013` (v3, rewritten), `research/07-risk-spike-register.md` (v2),
> `research/06` (historical). The S0–S8 PDF is a **dated baseline (2026-07-13)** — where it
> conflicts with this spec + MOM decisions D22–D29, this spec wins.

**Freshness contract (D25, amended):** publish→global-fresh **p99 ≤ 60s**, error budget
99.9% ≤ 5min, measured operational bound documented from POC. (KV guarantees "~60s, possibly
more" — no hard ceiling exists, so the SLO is statistical.) Editor read-your-writes via
`no-store` preview. Hard-ceiling upgrade path if ever needed: pointer as CDN object +
single-URL purge (available on all plans).

## 1. Release protocol (D26 + D28) — two-phase publish with R2 activation barrier

**Source of truth = Postgres. KV propagates. R2 materializes. Pointer flips LAST.**

1. **Commit:** one transaction writes content + a `releases` row + the outbox row.
   `release_id` = **global monotonic `BIGSERIAL`** (monotonic per tenant as a consequence;
   "per-tenant BIGSERIAL" is not a Postgres construct). The release row carries an **immutable
   manifest** pinning page configs, theme, tokens, registry version.
2. **Materialize (the barrier):** a serialized per-tenant publisher drains the outbox and
   renders **every routable response** for the release into **R2**, keyed by
   `{tenant}/{release_id}/{canonical-dims-hash}` — including **404 and redirect tombstones**
   with response metadata (status, headers). The routable set is enumerable from `routes`.
3. **Verify:** publisher checks the release's R2 set is complete.
4. **Activate:** only then write KV `host:{host}` → `{status:'active', tenantId, current: N,
previous: N-1}`. R2 is strongly consistent, so once the pointer names release N, N is fully
   readable everywhere.

Consequences: a deleted page exists in release N **as a 404 tombstone** — it can never be
resurrected from anywhere; the availability store is complete **by construction** (no async-tap
coverage gap); publish latency grows with page count (50-page tenant ≈ 50 renders — measure in
POC, parallelize inside the publisher if needed).

## 2. Edge algorithm (v3)

```ts
// 0. GATE FIRST — before any cache logic:
//    - method !== GET/HEAD            → proxy to origin, no-store
//    - reserved paths (/cart /checkout /account /api/* /preview) → proxy, no-store
//    - only public Class-A candidates continue

// 1. resolve host — KV only, FAIL-CLOSED (D29). No DB on the public path, ever.
const rec = await env.TENANTS.get(`host:${host}`, { type: 'json' });
// rec: {status:'active', tenantId, current, previous} | {status:'suspended'} | null
if (!rec || rec.status !== 'active') return storeNotFound();   // unknown & suspended: 404

// 2. canonical cache key: tenant, release, path, allowlisted+sorted query,
//    segment (default today), locale/currency (default today)
const key = cacheKeyFor(rec.tenantId, rec.current, url);

let res = await caches.default.match(key);
if (res) return present(res, 'HIT');

// 3. MISS → origin, pinned to the release (x-ratio-release: rec.current)
let originRes = null;
try { originRes = await fetch(originTarget(...), proxyInit(..., rec.current)); } catch {}
const transient = !originRes || originRes.status >= 500 || originRes.status === 429;

if (originRes && !transient) {                       // 200/301/404 = real answers
  if (originRes.ok && originRes.headers.get('x-cache') === 'long')
    ctx.waitUntil(caches.default.put(key, sanitizeForCache(originRes.clone())));
    // sanitize: internal s-maxage=1y, strip Set-Cookie + internal x-*; browser CC set by present()
  return present(originRes, 'MISS');
}

// 4. TRANSIENT only → R2 of the CURRENT release (complete by construction, incl. tombstones)
const r2 = await env.LAST_GOOD.get(r2KeyFor(rec.tenantId, rec.current, url));
if (r2) return presentR2(r2, 'STALE-R2');            // tombstone serves as 404/redirect — correct
return serviceUnavailable();
// NOTE: `previous` exists in the pointer for mid-propagation races, NOT as an outage
// fallback — current-release R2 already covers outages, and previous could resurrect
// deleted pages. Never serve previous on origin failure.
```

### E0 — read-path order experiment (run FIRST in POC-1)

The sketch above is **origin-first** (Cache API → origin → R2 on failure). Since D28 makes R2
complete per release, the simpler order may dominate:

**R2-first:** Cache API → **R2** → origin only if the object is unexpectedly missing.

Expected effects: shopper-path renders ≈ 0 (origin renders only at publish); miss-storm
amplification (A3) largely disappears; origin shrinks toward a publish-time renderer.
Cost to measure: R2 read latency from non-bucket-region PoPs (bucket is single-region; Cache API
refill absorbs repeats), R2 Class-B op cost at scale. **Measure both orders in P6/P15 before
retaining either.** If R2-first wins, §3's layer table re-labels: R2 = serving store, origin =
publish-time compiler.

### Unknown paths during total outage

Tombstones cover _deleted_ routes; never-existing URLs aren't enumerable. Rule: each release
materializes a **compact route index** object in R2 (path → object key, small JSON, Cache
API-cacheable at the edge). Unknown path → index miss → **404 even during full origin+DB
outage**. (Alternative — 503 for unknowns during outage — rejected: leaks outage state and
serves crawlers 5xx for junk URLs.)

### Release retention / GC

Releases N-1 and older stay in R2 until the **propagation safety window** closes (all colos
observed ≥ N via long-tail KV propagation + margin; operationally: retain ≥24h or last 2
releases, whichever is longer). GC must never delete a release that any stale pointer region
could still name (P16).

**Tenant provisioning / migration (D29):** all existing domains **pre-seeded** into KV
(bulk write in the migration workflow); new domains written **before DNS** (ADR-013 v3).
There is no public-path DB fallback — hostname spraying hits only KV. Suspend = overwrite
to `{status:'suspended'}` (effective ≤ ~60–90s; register D4).

## 3. Resilience layers

| Layer                                  | Scope                       | Role                                                                                       |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| Cache API (sanitized, 1y internal TTL) | per-PoP                     | performance only — per-colo, evictable, never the availability store                       |
| **R2 release store (D27/D28)**         | global, strongly consistent | availability store, complete per release incl. tombstones; REQUIRED for S3                 |
| Origin single-flight                   | per-process                 | bounds renders per process (amplification = pages × processes × PoPs — measured, not "≈1") |

## 4. Tech / infra (v3 deltas)

| #    | Decision                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------- |
| C10′ | Freshness = **p99 ≤60s + 99.9% ≤5min error budget** (D25 amended); measured bound from POC           |
| C13  | Publish = two-phase with R2 barrier (D28); publisher parallelism tuned by measured publish latency   |
| C14  | **No public-path DB fallback** (D29); pre-seed + write-before-DNS; KV records are status-tagged JSON |
| C11  | 1 KV read/request (pointer in host key) — ~$50/mo @100M req                                          |
| C12  | CF-for-SaaS hostnames on non-Enterprise confirmed; Enterprise pressure eliminated                    |

Infra: Workers Paid, 1 KV namespace, **1 R2 bucket (required)**, CF API token. ~$5–15/mo + R2 pennies.

## 5. POC-1 acceptance matrix (v3.1 — THE ratification gate for D25–D29)

The POC proves the **release state machine under failure**, not cache hits. E0 runs first.

| ID  | Test                  | Fault / workload                                                                                            | Required result                                                                                                                                  |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Publish state machine | Crash after DB commit; halfway through R2; after verification; halfway through host-key updates             | KV never names an incomplete release; retries idempotent; pointer never regresses                                                                |
| P2  | Concurrent publishes  | N and N+1 concurrent; duplicate + reordered outbox deliveries                                               | Per-tenant serialization holds; N+1 activates last; no lost/mixed release                                                                        |
| P3  | R2 completeness       | Release with 200s, redirects, deleted-route tombstones; delete/corrupt one object pre-verification          | Activation blocked unless count + metadata + checksums all match                                                                                 |
| P4  | Resurrection          | Publish `/old` as 200 → delete → activate → kill origin AND DB                                              | `/old` = 404 from current-release tombstone; `previous` never served                                                                             |
| P5  | Redirect correctness  | Change 200 route to 301/302; kill origin                                                                    | Exact status + `Location` survive through R2                                                                                                     |
| P6  | Multi-PoP outage      | Warm page in Mumbai, cold elsewhere; repeat from EU; stop ECS + block DB                                    | Warm → HIT; cold-per-PoP → current R2; **zero errors for materialized set**. Run under BOTH E0 orders                                            |
| P7  | Dependency matrix     | Fail origin, DB, R2, KV independently; then combinations                                                    | Cache hits survive origin/DB/R2 down; R2 path survives origin+DB down; no DB/previous fallback ever; double-failure terminal behavior documented |
| P8  | Gate                  | POST/PUT/PATCH/DELETE/OPTIONS/HEAD + `/cart` `/api` preview + encoded + double-slash variants               | Only eligible public GET/HEAD touch shared cache; rest no-store                                                                                  |
| P9  | Canonical key         | Vary query order, tracking params, filters, locale, currency, segment, host alias, encoding, trailing slash | Equivalent requests share a key; every output-varying input → distinct key; **discarded params provably cannot affect the origin render**        |
| P10 | Cache safety (C2)     | Same key, different cookies/auth/user canaries; forced Cache API + R2 hits                                  | Status/headers/body byte-identical; no Set-Cookie/auth/canary in Cache API or R2                                                                 |
| P11 | TTL regression        | Warm page, wait >300s, kill origin                                                                          | No 5-min expiry regression; HIT or falls through to R2                                                                                           |
| P12 | Fail-closed routing   | 10k unique random hosts + malformed KV records + suspended hosts                                            | **Exactly 0 DB queries**; flat edge latency; declared fail-closed response                                                                       |
| P13 | Reconciliation        | Delete a legit key; insert orphan; wrong status; stale release                                              | Job detects every divergence, alerts within declared SLA                                                                                         |
| P14 | Propagation           | Poll genuinely distinct colos (`cf-ray`-verified) after activation + suspension                             | Publish p99 ≤60s (provisional); suspend ≤90s. **Clock starts at publish/commit, not pointer write**                                              |
| P15 | Multi-PoP miss storm  | Flip release under multi-colo traffic                                                                       | Origin/R2 amplification + p99 + error rate within declared bound; no fleet instability. Both E0 orders                                           |
| P16 | Retention / GC        | Activate N+1 while a region still observes N; run GC concurrently                                           | Release N readable until safety window closes; GC never breaks stale-pointer regions                                                             |

### D28 feasibility protocol (largest new cost — test at real scale)

- Route counts: **50 / 500 / 5,000 / 50,000**. Workloads: one-page edit, route deletion,
  product update, theme-wide change. Concurrency: 1 / 10 / 100 tenants publishing. Sequential
  vs bounded-parallel rendering.
- Capture per stage: DB commit→R2 verified · verified→pointer write · pointer→per-region
  observed · **end-to-end publish→global-fresh** · render count, R2 PUTs/bytes, CPU, publisher
  backlog, cost · storage growth + retention cost.
- **If full materialization fails at realistic route counts → incremental content-addressed
  manifest**: unchanged pages reuse prior R2 objects (manifest maps route → content hash);
  only changed routes re-render. R2 strong consistency still supports the activation barrier.
  (Likely the end-state design anyway; theme-wide changes still re-render everything.)

### Freshness sample size

- POC gate: ≥ **100 activations** across 3 verified colos → provisional p99.
- 99.9% ≤5min objective sits behind an explicit **soak gate**: ≥10,000 observations over
  multiple days/traffic periods. Record the **maximum**, not just percentiles.

### Ratification rule — POC-1 is green ONLY when

1. Zero incomplete-release activations (P1–P3)
2. Zero stale-page resurrection (P4)
3. Zero per-user bytes in shared storage (P10)
4. Zero public-path DB queries (P12)
5. Zero errors for the materialized set during origin+DB failure (P6/P7)
6. D28 economically + operationally feasible at real route counts (feasibility protocol)
7. Freshness meets provisional p99; 99.9% deferred to the soak gate

Evidence discipline: raw measurements, commit IDs, Cloudflare config, `cf-ray` colos, and
failure-injection logs land in `research/08-cache-spine-results.md`. **Conclusions without raw
evidence do not ratify D25–D29.**

## 6. Out of scope

Multi-region · segment variants beyond the reserved key dimension · commerce data lane (A6/C6)
· theme un-mock · BYO domains · CDN-pointer hard-ceiling upgrade (documented, unbuilt).
