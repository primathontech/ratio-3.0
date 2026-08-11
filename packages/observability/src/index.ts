// @ratio/observability — Node logging with pino, for the container apps (origin, admin-api). JSON to
// stdout (12-factor: one stream; alert off the `lvl` field). Config is INJECTED (ADR-0001: a package
// reads no process.env — the app passes level from its env). Re-exports the shared conventions so a
// caller gets one import surface (createLogger + requestLog/classifyError/Logger).
import pino, { type DestinationStream } from 'pino';
import { trace, isSpanContextValid } from '@opentelemetry/api';
import { REDACT_KEYS, type Logger } from '@ratio/observability-core';

export * from '@ratio/observability-core';

export interface LoggerConfig {
  service: string; // the `svc` field, e.g. 'origin' | 'admin-api'
  level?: string; // injected by the app (e.g. process.env.LOG_LEVEL); defaults to 'info'
  dest?: DestinationStream; // injectable so tests capture output without monkeypatching a global
}

export function createLogger(cfg: LoggerConfig): Logger {
  return pino(
    {
      level: cfg.level ?? 'info',
      base: { svc: cfg.service }, // drop pino's pid/hostname noise; the platform tags the stream
      formatters: { level: (label) => ({ lvl: label }) }, // emit `lvl:"info"`, shared across runtimes
      redact: { paths: [...REDACT_KEYS], censor: '[redacted]' },
      // Correlate logs with traces: stamp the ACTIVE span's ids so a log line links to its trace in
      // SigNoz. Uses only the LIGHT @opentelemetry/api (not the SDK — that stays isolated in
      // @ratio/observability-tracing); a no-op {} when tracing is off (no SDK → invalid span context).
      mixin() {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
    },
    cfg.dest
  );
}
