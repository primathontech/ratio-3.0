// OpenTelemetry tracing (ADR-0002 tier 2), Node side. OTLP export → any OTel backend; our org uses
// SigNoz (OTLP-native), so `endpoint` is the SigNoz OTLP ingest and `headers` carries its ingestion
// key. OFF by default: no endpoint → no provider is registered, so `withSpan` runs against the API's
// no-op tracer (≈free). Config is INJECTED (ADR-0001 — the app reads OTEL_* env and passes it here).
//
// This increment is MANUAL instrumentation (explicit spans on the critical path); full
// auto-instrumentation (HTTP/pg/fetch) is a follow-up once the ESM loader hook is wired.
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
  trace,
  context,
  propagation,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanStatusCode,
  SpanKind,
  type Span,
  type Attributes,
} from '@opentelemetry/api';

export { SpanKind } from '@opentelemetry/api';

export interface TracingConfig {
  service: string; // resource service.name, e.g. 'origin'
  endpoint?: string; // OTLP base URL (SigNoz ingest). Absent → tracing stays OFF.
  tracesEndpoint?: string; // full traces URL, used VERBATIM (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
  headers?: Record<string, string>; // e.g. { 'signoz-ingestion-key': '…' }
  sampleRatio?: number; // 0..1 of ROOT traces to sample; default 1 (parent decisions are honored)
}

export interface Tracing {
  shutdown: () => Promise<void>; // flush the buffer on shutdown — call from SIGTERM
}

let provider: NodeTracerProvider | undefined;

// Returns a shutdown handle when tracing was turned on, else null (off by default — no endpoint).
export function initTracing(cfg: TracingConfig): Tracing | null {
  if (provider || (!cfg.endpoint && !cfg.tracesEndpoint)) return null;
  // Surface exporter/pipeline failures (bad URL, expired key, blocked network) — else tracing looks
  // "on" but silently drops everything.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  const url = cfg.tracesEndpoint ?? cfg.endpoint!.replace(/\/$/, '') + '/v1/traces';
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.service }),
    // Honor an upstream (edge) sampling decision; sample `sampleRatio` of ROOT traces otherwise so
    // ops can dial volume down without a code change.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.sampleRatio ?? 1) }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url, headers: cfg.headers }))],
  });
  provider.register(); // registers the W3C trace-context propagator (edge↔origin trace continuity)
  return { shutdown: () => provider!.shutdown() };
}

const tracer = () => trace.getTracer('@ratio/observability');

// Run fn inside a span (child of the active context). Records ok/error status; NEVER the raw error
// message (untrusted — same discipline as the logs), but records the exception TYPE so it still shows
// in SigNoz's exception view. Off (no provider) → a no-op span, so cheap to leave in hot paths.
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  return tracer().startActiveSpan(name, { kind }, async (span) => {
    span.setAttributes(attrs);
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e) {
      const errType = e instanceof Error ? e.name : 'Error';
      span.recordException({ name: errType, message: '[redacted]' }); // type only, no PII
      span.setStatus({ code: SpanStatusCode.ERROR, message: errType });
      throw e;
    } finally {
      span.end();
    }
  });
}

// Run fn as a SERVER span that CONTINUES the trace from incoming W3C headers (traceparent/tracestate
// from the edge), so edge → origin → backend is one trace and child withSpan() calls nest under it.
// No headers → a new root trace. Off (no provider) → no-op.
export async function withRequestSpan<T>(
  name: string,
  attrs: Attributes,
  headers: Record<string, string | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const ctx = propagation.extract(context.active(), headers);
  return context.with(ctx, () => withSpan(name, attrs, fn, SpanKind.SERVER));
}
