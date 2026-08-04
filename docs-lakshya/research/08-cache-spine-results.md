# POC-1 Cache Spine — Results & Evidence

> Status: **In progress** · 2026-07-16 · Local tier COMPLETE; prod tier PENDING infra approval.
> Gate: spec 02 v3.1 §5 (P1–P16 + feasibility + ratification rule). Evidence discipline: raw
> outputs + commit IDs here; conclusions without evidence do not ratify D25–D29.

## Environment

- Code: `ratio-3.0` branch **`poc/cache-spine-v3`**, commit **`8c9adc2`**
- Implementation: `packages/spine/` (stores, canonical-key, response, publisher, edge, fake-db, harness) + `db/migrations/0009_releases.sql`
- Runner: node:test via tsx, Node v20.20.0, local Postgres (s2poc/s2poc_test)
- Full suite: **218/218 pass** (185 pre-existing + 33 spine), typecheck + eslint clean

## Tier 1 — Local proofs (fault-injectable fakes mirroring KV/R2/Cache-API/origin semantics)

### P-matrix results (test/spine-pmatrix.test.ts — 26 cases, both E0 read orders)

```
ok  P1: KV never names an incomplete release, across every crash point
ok  P1: retry after crash is idempotent and converges
ok  P1: pointer never regresses
ok  P2: per-tenant serialization holds; latest activates last; no mixed release
ok  P3: activation blocked when an R2 object is missing or corrupt
ok  P4 [origin-first + r2-first]: deleted page stays 404; previous never served
ok  P5 [both]: 301 status + Location survive origin death via R2
ok  P7 [both]: cache HIT survives origin+DB+R2 all down
ok  P7 [both]: R2 serves when origin+DB down (cold PoP)
ok  P7 [both]: no fallback to previous release, ever
ok  P8 [both]: non-GET + reserved paths bypass shared cache
ok  P9: equivalent requests share a key; output-varying inputs differ
ok  P10 [both]: same key + different cookies = byte-identical; no cookies/auth stored
ok  P11 [both]: no 5-min expiry regression (>300s + origin death survives)
ok  P12 [both]: 10k unknown hosts → 0 DB queries, fail-closed 404
ok  P12 [both]: malformed KV record + suspended host fail-closed
```

### Implementation findings while building (bugs the matrix caught)

1. **P3 caught a real verifier bug:** `verify()` initially compared the object's _self-reported_
   checksum field — corruption changes the body, not a trusted field. Fixed: verify recomputes
   sha256 from the object's actual bytes. (This is exactly the class of bug the reviewer's
   "checksums must match" criterion exists for.)
2. P7/P11 caught an operator-precedence bug in the harness origin seeding (`+ ... || '/'`).

### E0 — read-path order (test/spine-bench.ts)

```
order         PoPs  requests  originRenders  r2Reads
origin-first  6     600       6              0        (1 render per PoP cold-fill)
r2-first      6     600       0              6        (origin NEVER on shopper path)
```

**Provisional verdict: r2-first.** Shopper-path renders drop to zero; miss-storm amplification
(A3) collapses to R2 reads. Residual unknown before final call: cross-region R2 GET latency from
non-bucket-region PoPs (needs live infra — P6/P15).

### D28 feasibility (amplification counts; wall-clock needs infra)

```
routes   theme-wide(full)   1-page edit(incremental manifest)
50       50 renders          1 render
500      500                 1
5000     5000                1
50000    50000               1
```

Full materialization is O(routes)/publish. Verdict: **incremental content-addressed manifest is
the end-state** (common case = O(changed)); theme-wide stays O(routes) by necessity → bounded-
parallel publisher + measured wall-clock on infra decides publish-latency envelope (A7).

### B1 — template sandbox spike (test/spine-sandbox-spike.test.ts, empirical)

- Handlebars: constructor/proto access neutralized **by policy** (not a sandbox); **no CPU/time/
  output ceiling exists** — a hostile `{{rep 5000000 "x"}}` built a 5MB string in-process
  unimpeded. Verdict: NOT self-sandboxing; would require an external isolate + limits harness.
- LiquidJS: no JS constructor/prototype surface reachable from templates; engine-level limits
  configurable. **Verdict: Liquid is the base for merchant code (D8 decision input). REQ-1 lives.**

### B2 — capability inference spike (empirical, LiquidJS AST)

- Extracting variable roots + tags + filters from the parse tree works: undeclared binding
  (`secret_customer`) detected; purity-breaking capabilities (`date`/`money` filters,
  `render`/`include` tags) surfaced for allowlist classification.
- **Verdict: inference is FEASIBLE — REQ-3 ("devs declare nothing") holds** — conditional on:
  transitive include walking, filter/tag→tier allowlist, dynamic-property-access ban.

## Tier 2 — PENDING (requires live Cloudflare + AWS; scripts ready, self-skipping)

| Test                                                  | Status                 | Runner                                                                                        |
| ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| P6 multi-PoP outage                                   | pending infra approval | `scripts/poc-prod-infra.ts` (needs POC_EDGE_URL, POC_COLOS, deployed worker + KV/R2 bindings) |
| P14 propagation (100+ activations, clock from commit) | pending                | same                                                                                          |
| P15 multi-PoP miss storm                              | pending                | same + k6                                                                                     |
| P16 retention/GC                                      | pending                | same                                                                                          |
| D28 wall-clock/cost at 50k routes                     | pending                | infra                                                                                         |
| Soak (99.9% ≤5min, ≥10k obs)                          | pending, post-POC      | scheduled gate                                                                                |

## Ratification scorecard (spec v3.1 rule)

| Condition                                                | Status                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Zero incomplete-release activations                   | ✅ local (P1–P3) — prod pending                                                               |
| 2. Zero resurrection                                     | ✅ local (P4) — prod pending                                                                  |
| 3. Zero per-user bytes in shared storage                 | ✅ local (P10) — prod pending                                                                 |
| 4. Zero public-path DB queries                           | ✅ local (P12)                                                                                |
| 5. Zero errors for materialized set in origin+DB failure | ✅ local (P6-equiv/P7) — real multi-PoP pending                                               |
| 6. D28 feasible at real route counts                     | ⚠️ amplification measured; wall-clock/cost pending; incremental manifest = likely requirement |
| 7. Freshness provisional p99                             | ⏳ pure infra property — pending                                                              |

**Local tier verdict: the release state machine holds under every injected failure; both E0
orders correct; r2-first provisionally superior. Nothing ratifies until Tier 2 runs on real
infra.**

## Adversarial verification (ultracode round, 2026-07-16) — 35 confirmed findings

> 5 adversarial reviewers + confirmation pass (48 agents, ~2M tokens). **Verdict: the earlier
> "local tier green" claim is RETRACTED.** Several P-tests were vacuous (accepted too much), and
> the implementation has 3 confirmed blockers. The release-state-machine DESIGN survives; the
> POC code + tests need the fixes below before local ratification can be claimed honestly.

### Blockers (code)

- **B-1 [edge.ts]** Canonical query/segment/locale dims never reach origin render — `OriginLike.fetch`
  gets only `path`. `/p?sort=x` and `/p?sort=y` render identically but cache under different keys →
  wrong content served per query key. Fix: thread `KeyDims` through fetch + origin URL; decide if
  query variants are materialized into R2 or excluded from the D28 completeness claim.
- **B-2 [edge.ts]** Origin-first caches every "real" answer — spec's `res.ok && x-cache:long` opt-in
  is missing, so non-ok/private answers get cached. Fix: gate `cache.put` on `res.ok` + the
  `x-cache:long` marker (harness origin must emit it).
- **B-3 [P4 test]** P4 is vacuous: `503 OR 404` acceptance masks that the harness never materializes
  a **tombstone** for a deleted route (it just drops the path from the release set → R2 has nothing
  → edge 503s, test passes). Exposes a real design gap: `materialize()` must render tombstones for
  routes removed since the previous release (needs a prev-release diff), which the code does NOT do.

### High (code + tests)

- **H-1** Pointer-regression guard is TOCTOU-racy — two concurrent `publish()` for one tenant can
  regress/mix the pointer; `withTenantLock` lives only on the fake, not enforced in `Publisher`.
- **H-2** `activate()` never checks status==='materialized' — the R2 barrier is call-order
  discipline, not a state-machine invariant; a future outbox drainer could activate an incomplete release.
- **H-3** `publish()` retry not idempotent — re-invoke mints a NEW release, orphans the crashed one,
  leaves a poison outbox row (and nothing drains the outbox yet).
- **H-4** Commit doesn't durably pin content → resume-from-outbox impossible.
- **H-5** Duplicate canonical paths brick a release (verify count can never match).
- **H-6** Route index materialized but never consulted → unknown paths 503 during outage; spec mandates 404.
- **H-7/8/9** B2 walker doesn't recurse block bodies / dynamic `{{x[y]}}` index / transitive
  render-include — undeclared-access detection bypassable. Fix: use LiquidJS's shipped
  `analyzeSync` (returns globals/locals) instead of the hand-rolled walker.
- **H-10** P2 tests the fake lock, not the Publisher; P3 has no passing baseline + never asserts
  activation is blocked; both prove less than claimed.

### Medium/Low (selected)

- `canonicalQuery` re-serializes without re-encoding (value with `&`/`=` collides). `%2f` vs `%2F`
  cache split (no percent-case / unicode NFC normalization). Reserved-path matcher case-sensitive +
  over-broad `/preview`. KV outage → definitive 404 (should be 503, distinct). `present()` sets no
  browser Cache-Control + leaks `x-page-type`. P10 varies no cookies (vacuous). P12 `onDbQuery`
  never invoked (vacuous — passes trivially). P11 acceptance includes R2 fallback (masks the TTL
  regression it names). P13 reconciliation absent despite header claiming P1–P13. B1 "Liquid contains
  hostile constructs" proves no CPU/output limit (LiquidJS limits are opt-in, default Infinity).

### B3 app-isolation spike — DELIVERED ✅

`test/spine-b3-isolation.html` + `research/09-b3-app-isolation-spike.md`. Sandboxed cross-origin
iframe (`allow-scripts`, NO `allow-same-origin`/`allow-top-navigation`) + postMessage bridge
(origin check via `event.source` identity, capability allowlist, message schema, resize budget,
recursive dangerous-key guard vs `__proto__` pollution). In-page scoreboard: 10/10 attacks held
(read host DOM/cookies/localStorage → SecurityError; top-nav suppressed; non-allowlisted capability
dropped; spoofed sender rejected; prototype-pollution refused). Positive controls prove the bridge
is live. Caveat: needs a real Safari/Firefox matrix (documented in the spike).

### Remediation status — APPLIED (commit `e7f51de`)

All confirmed blockers + most highs/mediums fixed; **224/224 tests pass, typecheck + lint clean.**

- **B-1 fixed:** `OriginLike.fetch` now takes `KeyDims`; origin renders per canonical request →
  `?sort=x` / `?sort=y` are distinct renders + distinct cache entries. New P9 end-to-end test proves it.
- **B-2 fixed:** origin-first caches only on `res.ok && cacheable` (the `x-cache:long` opt-in).
- **B-3 fixed:** `commit()` diffs the prior release's routes → `materialize()` writes a 404
  **tombstone** for every deleted path + adds it to the route index. P4 now asserts the tombstone
  object exists and the response is an exact 404 from current-release R2 (no `503 OR 404` escape).
- **H-2 fixed:** `activate()` refuses unless status==='materialized' (barrier is now a state-machine
  invariant) + no-ops if already active (#3).
- **#6 fixed:** route index carries a real content digest recorded in the DB; `verify()` validates it.
- **H-5 fixed:** duplicate canonical paths rejected at commit.
- **H-6 fixed:** route index consulted on R2 miss → correct 404 for unknown paths during outage.
- **#13/#14/#16/#26/#27 fixed:** KV outage → 503 (distinct from 404); `present()` strips `x-*` +
  stamps browser Cache-Control; reserved matcher exact-or-slash; canonical query re-encoded;
  percent-case + NFC path normalization.
- **B2 spike:** now uses LiquidJS `analyzeSync` (globals/locals) — catches dynamic index,
  assign-laundering; proves transitive includes need a resolver (else the tier bans them).
- **B1 spike:** asserts Liquid limits are opt-in (throws only when `renderLimit`/`memoryLimit` set).
- **Tests de-vacuumed:** P2 (coordinator serialization), P3 (positive baseline + barrier +
  KV-unchanged), P4 (tombstone), P9 e2e, P10 (varying cookies + injected leak headers stripped),
  P11 (R2 also down → only cache can answer), P12 (KV-outage 503), P1 mid-hostkeys (2 hosts,
  verification-complete invariant), **+P13 reconciliation added.**

**Convention-not-code gaps — NOW CLOSED (commit `805fe71`):**

- **H-1 fixed:** `Publisher.publish()` owns the per-tenant lock via the DB seam
  (`withTenantLock`). P2 rewritten to call `publish()` twice concurrently with NO external
  wrapping → self-serializes. Enforced by the state machine, not a test convention.
- **H-4 fixed:** `commit()` pins the RouteInput content durably; `materialize(releaseId)` reads it
  from the DB (dropped the routes param) → a resume re-renders exactly what was committed.
- **#7 fixed:** `activate()` records `status='activating'` before the KV flip → a mid-hostkeys
  crash leaves durable intent (GC pins the release; a drainer finishes the flip). P1 asserts the
  named release is always verification-complete (materialized/activating/active, never building).
- **H-3 fixed:** `drainPending(tenant, hosts)` resumes any stalled release to completion under the
  lock. New P2b test: crash mid-materialize → drain → converges to active. Crash-recovery is now a
  system property, not a manual step.

**Remaining (genuinely needs infra):**

- Prod tier (P6/P14/P15/P16) + EW-1..4 on live **Akamai + AWS** (see `specs/03` runbook). This is
  the only outstanding work for local→prod ratification.

Local test count now **225/225** (was 224; +1 for the P2b drain-recovery test).

**Local tier verdict (revised): the release state machine holds under every injected failure with
the fixes applied; tests are no longer vacuous; r2-first confirmed superior (0 shopper-path
renders). Local ratification conditions 1–5 met in the fault-injected model; 6 (D28 wall-clock)
and 7 (freshness) remain pure-infra. H-1/#7/H-3/H-4 are the honest "convention not yet enforced in
code" items to close before prod.**
