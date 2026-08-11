// @ratio/observability — Node logging with pino, for the container apps (origin, admin-api). JSON to
// stdout (12-factor: one stream; alert off the `lvl` field). Config is INJECTED (ADR-0001: a package
// reads no process.env — the app passes level from its env). Re-exports the shared conventions so a
// caller gets one import surface (createLogger + requestLog/classifyError/Logger).
import pino, { type DestinationStream } from 'pino';
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
    },
    cfg.dest
  );
}
