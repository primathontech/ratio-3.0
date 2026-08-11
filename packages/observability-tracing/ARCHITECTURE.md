# Architecture — @ratio/observability-tracing

OpenTelemetry **tracing** for the Node apps: `initTracing` (OTLP export, off unless an endpoint is
injected) + `withSpan`/`withRequestSpan`. OTLP goes to any OTel backend — our org uses **SigNoz**
(OTLP-native), so the endpoint is SigNoz's ingest and the ingestion key rides in the OTLP headers.

Kept a SEPARATE package (not folded into `@ratio/observability`) so importing the **logger** does not
transitively load the heavy OTel SDK — the same dependency-isolation principle as the edge split. An
app that wants tracing imports this; an app that only logs doesn't pay for it.

- **Role:** library — imported by Node apps; never reads `process.env` (the app injects the endpoint).
- **Not for the edge:** the OTel Node SDK can't run on Workers; edge trace continuity is via forwarding
  the W3C `traceparent`, not this package.
- See `docs/adr/0002-observability.md`.
