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
Logging is centralized so the whole system shares one discipline. It's **three packages** — split by
runtime so the boundary is enforced (an edge worker physically cannot pull pino), not just a
convention:

- **`@ratio/observability-core`** → pure shared bits: the `Logger` shape, redaction, `classifyError`.
  No deps, no Node APIs; both loggers depend on it, neither depends on the other.
- **`@ratio/observability`** (node) → **pino** for the container apps (origin, admin-api).
- **`@ratio/observability-edge`** → a Workers-safe `console.log(JSON)` logger (pino needs Node APIs a
  Cloudflare Worker can't have) emitting the SAME shape, so edge + origin logs correlate. Bundles
  clean into a Worker (verified via `wrangler deploy --dry-run`).

Config is injected — the packages read no `process.env` (ADR-0001). (This is where tier-2 OTel slots
in — origin traces bind the same `reqId`.)

Apps own their **domain events** on top (origin: `cart_add`/`cart_update`/`checkout`/`commerce_error`;
`cart_add.lines` = the line count the backend echoed, `0` = took the call/added nothing — the datum
that diagnoses the empty-cart class). Every silent `catch {}` on the commerce path is now an event.
JSON to stdout (12-factor: one stream; alert off `lvl`, not stderr-splitting). Always on:
`aws logs tail /ecs/ratio-origin --filter '"reqId"'` — **query the logs, never redeploy to debug.**

Two safety rules the code enforces, not just documents:

- **Correlation.** A per-request `reqId` (adopted from the edge's `x-request-id` / `traceparent`
  trace-id, else minted) is bound on a child logger and echoed on the response, so all events for one
  request group together and correlate with the edge access log — and it's the seam tier-2 traces use.
- **Content, not just schema.** A fixed field _schema_ does not bound field _content_: a backend's raw
  error `message` is untrusted and can carry a token/PII. So commerce errors are mapped to a **closed
  taxonomy** (`network` / `timeout` / `backend_rejected` / …) plus the error's type name — the raw
  message is dropped. `redact` is a defense-in-depth backstop; typed per-event helpers pick their
  fields explicitly (a runtime allowlist, not only the type system).

**Tier 2 — OpenTelemetry tracing on the ORIGIN (increment 1 implemented).**
Tracing lives in its OWN package, **`@ratio/observability-tracing`** — separate from the logger so
importing `@ratio/observability` doesn't load the heavy OTel SDK (same dependency-isolation principle
as the edge split). `initTracing` exports via **OTLP**; the backend is **SigNoz** (our org standard,
OTLP-native) — set `OTEL_EXPORTER_OTLP_ENDPOINT` + the ingestion key in `OTEL_EXPORTER_OTLP_HEADERS`.
**OFF by default** (no endpoint → no provider → `withSpan` is a no-op, safe in hot paths).

Increment 1 is **manual** instrumentation: the origin middleware opens an `origin.request` span that
**continues the edge's W3C `traceparent`** (so edge → origin is one trace), and the GoKwik calls
(`cart.add`/`cart.get`/`checkout.create`) are child spans with status + latency + attributes
(`cart.lines` — the empty-cart signal shows in the trace too), all tied to `reqId`. Full
**auto-instrumentation** (HTTP/`pg`/`fetch`) is the follow-up, once the ESM loader hook is wired into
the Docker CMD. Later, tier-1 logs also ship to SigNoz via OTLP so logs + traces share one UI.

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
