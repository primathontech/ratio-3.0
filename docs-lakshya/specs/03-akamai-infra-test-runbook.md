# Runbook — Akamai + AWS Infra Test (POC-1 Tier 2)

> Status: Draft · 2026-07-20 · Proves P6/P14/P15/P16 + Akamai spikes (EW-1..4) on real infra.
> Edge = Akamai EdgeWorkers + EdgeKV (D36); availability store = AWS S3 (D35); Fast-Purge
> cache-tags for invalidation. **Scope: INDIA-ONLY** (international ≥1yr out — see §Scope).
> Local logic tier (P1–P13, 224/224) is already green + transport-agnostic; this is only the
> infra-dependent tier.

## Scope — India-only for now (2026-07-20)

- Single region: **AWS `ap-south-1` (Mumbai)** origin + S3; **Akamai India PoPs**.
- Consequences: cross-region S3→edge egress/RTT is small (reinforces D35 S3 choice); DPDP
  residency satisfied by construction; miss-storm amplification bounded (~4–5 India PoPs, not
  ~300 global); EdgeKV propagation well under the ≤60s SLO.
- **Deliberately NOT built now:** multi-region (ADR-009 deferred), NetStorage, global PoP tuning.
- **Seams kept for the year-out international move (add, don't rebuild):** region/segment cache-key
  dimension reserved-but-unimplemented; S3 swappable to NetStorage behind `R2Like`; region/bucket/
  PoP-list are CONFIG values, never hardcoded "india".

## Phase 0 — Provision (owner: user)

1. **Akamai** contract with **EdgeWorkers + EdgeKV** enabled:
   - test property on a controlled hostname (e.g. `poc.ratiodev.in`)
   - an EdgeWorker id (empty), an EdgeKV namespace
   - Fast Purge API client (`.edgerc`: client_token / client_secret / access_token / host)
2. **AWS:** S3 bucket in `ap-south-1` + IAM key (`s3:PutObject/GetObject/ListBucket`).
3. **Origin:** existing ECS Hono service + S3 write access + run `migration 0009` (release tables).
4. **Two probe hosts in DISTINCT India PoPs** (Mumbai + Delhi/Chennai/Bangalore; India+Singapore
   only if two India colos can't be forced) with `curl` + `k6`.
5. **Throwaway tenant** `poc.ratiodev.in` → `t_poc` rows in Neon. Never a real store.
6. Hand to Claude: `.edgerc`, EdgeKV namespace id, EdgeWorker id, S3 bucket + IAM key, probe IPs.

## Phase 1 — Build + deploy (owner: Claude, after Phase 0)

7. Swap proven fakes for real drivers behind the interfaces: EdgeKV → `KVLike`, S3 → `R2Like`,
   edge algorithm → EdgeWorker bundle. Logic unchanged (already proven).
8. Wire two-phase publisher to Neon + S3.
9. Fill `scripts/poc-prod-infra.ts` bodies + `prove-prod.yml` (one-click matrix).
10. Deploy EdgeWorker, activate property on staging, seed `t_poc`.

## Phase 2 — Run the matrix (order matters: EW-1 is the gate)

| #      | Test                       | Method                                                                                                 | Pass                                                                                                                                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10** | **EW-1 (fit) — RUN FIRST** | Deploy real EdgeWorker; read Akamai CPU-ms + wall + subrequest report                                  | Under EdgeWorker budget with headroom. **FAIL → split: push S3 fetch + index logic to ECS origin; EdgeWorker only {resolve tenant, read pointer, build key, serve-or-forward}** |
| 11     | EW-2 (EdgeKV)              | publish → poll pointer from both India PoPs                                                            | fast reads; bounded propagation                                                                                                                                                 |
| 12     | P14 (propagation)          | ≥100 publishes, poll both PoPs via Akamai debug headers, **clock from commit**                         | p99 ≤60s; record MAX                                                                                                                                                            |
| 13     | P6 (SPOF kill)             | warm page in PoP-A, cold in PoP-B → `aws ecs update-service --desired-count 0` + block Neon → re-probe | warm HIT, cold from S3, deleted route = 404 tombstone, **0 errors**; then scale ECS back                                                                                        |
| 14     | P15 (miss storm)           | k6 from both PoPs, flip release mid-load                                                               | origin/S3 amplification + p99 + error rate within declared bound; no instability                                                                                                |
| 15     | P16 (retention/GC)         | activate N+1 while PoP-B still reads N; run GC                                                         | release N readable through its window                                                                                                                                           |
| 16     | EW-3 (Fast Purge)          | purge by cache-tag; time tag→fresh across both PoPs                                                    | ~5s                                                                                                                                                                             |
| 17     | EW-4 (cost)                | S3→Akamai cold-miss RTT + S3 egress numbers (India-local → expected small)                             | validates D35 cost assumption; feeds S6                                                                                                                                         |

## Phase 3 — Record + ratify

18. Raw evidence (Akamai debug headers, timestamps, commit ids, aws/purge logs) → `research/08`
    "Tier 2 — Akamai (India)" section. **No raw evidence, no ratification.** Flip scorecard rows.

## Critical path ⚠️

**EW-1 gates the design.** Akamai EdgeWorkers are far tighter than CF Workers (strict CPU-ms,
~4 subrequests). Our edge does EdgeKV read + cache check + S3 fetch-on-miss + index/tombstone
logic. Run EW-1 on day 1 of Phase 2; if it doesn't fit, the fix is architectural (thin the worker,
move fetch+index to origin) — cheaper to learn before building the rest.

## Parallel track (no infra needed — do now)

Close the 3 code gaps so the infra run tests enforced behavior, not convention:

- H-1 Publisher owns per-tenant lock (Postgres advisory lock)
- Finding #7 record `status='activating'` before the pointer flip
- H-3/H-4 outbox drainer + durable content pinning
