# ADR-0002: Observability (origin logs, metrics, live debug)

**Status:** accepted (2026-08-12)

## Context

Diagnosing a production storefront issue currently means shipping a one-off debug build:
enable a flag → deploy → read → fix → deploy → remove. That is slow and unsustainable, and it is a
symptom, not the disease. The disease:

- The origin's commerce paths **silently swallow backend failures** (`} catch {}`) — correct for UX
  (a shopper must never see a 500) but it makes failures **vanish**. The "cart id but empty cart" bug
  went undiagnosed for exactly this reason.
- The origin emits **no structured logs and no metrics**. The _edge_ has D-R8 (a structured access
  record per request + Analytics Engine metrics); the **origin never got the same treatment**.

The two runtimes differ and must be treated differently: the **origin** is Node on ECS (stdout →
CloudWatch); the **edge** is a Cloudflare Worker (Workers Logs + Analytics Engine, no Node APIs).

## Decision

Three tiers. Build tier 1 now; adopt OpenTelemetry deliberately for tiers 2–3.

**Tier 1 — structured logs (this ADR, implemented).**
The origin emits structured, allowlisted JSON events to stdout (`apps/origin/src/log.ts`), the same
discipline as the edge access-log: a **fixed, non-sensitive field set** — a token, cookie, secret,
raw body, or query string can NEVER enter an event, by construction. Every silent `catch {}` on the
commerce path is replaced with an event. `cart_add` carries `lines` = the line count the backend
echoed (`0` = the backend took the call but added nothing) — the datum that diagnoses the empty-cart
class. Always on: live debugging becomes `aws logs tail /ecs/ratio-origin --filter '"evt":"cart_add"'`
— **query the logs, never redeploy to debug.**

**Tier 2 — OpenTelemetry tracing + metrics on the ORIGIN (target, next).**
Adopt the OTel Node SDK on the origin: auto-instrument HTTP / `pg` / outbound `fetch`, so each request
is a trace — edge → origin → the GoKwik call — with span status + latency. A failed `addToCart`
becomes a visible span, not a swallowed catch. Export via OTLP (backend TBD: X-Ray / Grafana /
Honeycomb). Tier-1 events re-emit as OTel logs under the same trace id, so nothing is wasted.

**Tier 3 — authenticated on-demand live debug (target).**
A per-request debug capability that is **always available but auth-gated** — the edge injects
`x-ratio-debug` only for a request carrying a signed debug token (or the edge secret) — surfacing
per-request internals live on any deploy, with **no flag and no redeploy**. Gated by auth, not by a
build. This replaces the enable-flag-deploy-remove cycle entirely.

**Edge:** stays on its Workers-native D-R8 signal (OTel's Node SDK doesn't run in Workers, and the
Workers-OTel libraries are immature). To make traces span the hop, the edge **propagates a request /
trace id** (a `traceparent`-shaped header) to the origin so origin traces and edge access-logs
correlate. Revisit a Workers OTel exporter only if unified tracing demands it.

## Consequences

- Backend failures are visible immediately (tier 1), with no code change or redeploy per incident.
- OpenTelemetry is a deliberate, origin-first adoption — not slipped in, and not forced onto the edge.
  It adds a dependency + a collector/backend, decided when tier 2 lands.
- The field-allowlist discipline (no secrets/PII/tokens) is mandatory for every tier.
