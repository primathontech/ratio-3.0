// OpenTelemetry tracing (ADR-0002 tier 2), Node side. OTLP export → any OTel backend; our org uses
// SigNoz (OTLP-native), so `endpoint` is the SigNoz OTLP ingest and `headers` carries its ingestion
// key. OFF by default: no endpoint → no provider is registered, so `withSpan` runs against the API's
// no-op tracer (≈free). Config is INJECTED (ADR-0001 — the app reads OTEL_* env and passes it here).
//
// This increment is MANUAL instrumentation (explicit spans on the critical path); full
// auto-instrumentation (HTTP/pg/fetch) is a follow-up once the ESM loader hook is wired.
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  type Span,
  type Attributes,
} from '@opentelemetry/api';

export interface TracingConfig {
  service: string; // resource service.name, e.g. 'origin'
  endpoint?: string; // OTLP base URL (SigNoz ingest). Absent → tracing stays OFF.
  headers?: Record<string, string>; // e.g. { 'signoz-ingestion-key': '…' }
}

let started = false;

export function initTracing(cfg: TracingConfig): boolean {
  if (started || !cfg.endpoint) return false; // off by default — no endpoint, no overhead
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.service }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: cfg.endpoint.replace(/\/$/, '') + '/v1/traces',
          headers: cfg.headers,
        })
      ),
    ],
  });
  provider.register(); // registers the W3C trace-context propagator (edge↔origin trace continuity)
  started = true;
  return true;
}

const tracer = () => trace.getTracer('@ratio/observability');

// Run fn as a request span that CONTINUES the trace from incoming W3C headers (traceparent/tracestate
// from the edge), so edge → origin → backend is one trace and child withSpan() calls nest under it.
// No headers → a new root trace. Off (no provider) → no-op.
export async function withRequestSpan<T>(
  name: string,
  attrs: Attributes,
  headers: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const ctx = propagation.extract(context.active(), headers);
  return context.with(ctx, () => withSpan(name, attrs, () => fn()));
}

// Run fn inside a span (child of the active context). Records ok/error status; never swallows the
// error. Off (no provider) → a no-op span, so this is safe and cheap to leave in hot paths.
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attrs);
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e) {
      // Only the error TYPE — never the raw message (untrusted; same discipline as the logs).
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.name : 'error',
      });
      throw e;
    } finally {
      span.end();
    }
  });
}
