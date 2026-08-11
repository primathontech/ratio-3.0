import { serve } from '@hono/node-server';
import { configureDb } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { initTracing } from '@ratio/observability-tracing';
import { app } from './index';
import { config } from './config';

// Origin-ONLY entrypoint for the container (AWS App Runner / Fargate). No edge here —
// the edge is the Cloudflare Worker. App Runner injects PORT and needs a 0.0.0.0 bind.
const PORT = Number(process.env.PORT || 8080);

// OpenTelemetry tracing (ADR-0002 tier 2). OFF unless OTEL_EXPORTER_OTLP_ENDPOINT is set — point it at
// SigNoz (OTLP-native) with the ingestion key in OTEL_EXPORTER_OTLP_HEADERS (`key=value,key=value`).
function parseOtlpHeaders(s?: string): Record<string, string> | undefined {
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}
const tracing = initTracing({
  service: 'origin',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  tracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  sampleRatio: process.env.OTEL_TRACES_SAMPLER_ARG
    ? Number(process.env.OTEL_TRACES_SAMPLER_ARG)
    : undefined,
});

// Flush the span buffer on shutdown (ECS/Fargate sends SIGTERM on deploy/scale-down) — otherwise the
// last BatchSpanProcessor batch is silently dropped every rollout.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void Promise.resolve(tracing?.shutdown()).finally(() => process.exit(0));
  });
}

// Inject DB config before serving; the pool opens lazily on the first query.
configureDb({ connectionString: config.databaseUrl, insecureTls: config.insecureTls });

// Fail fast: refuse to boot in production without a real edge secret (H2 hardening).
resolveEdgeSecret(process.env);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () =>
  console.log(`origin (Hono, container) listening on 0.0.0.0:${PORT}`)
);
