// Edge logger — Workers-safe. pino needs Node APIs it can't have on Cloudflare Workers, so this is a
// tiny console.log(JSON) sink that emits the SAME shape as the Node logger (`lvl`, `svc`, `time`,
// bound `reqId`, event fields) with the same level filtering + redaction. Same package, same
// discipline, runtime-appropriate sink — an edge worker imports `@ratio/observability/edge`.
import { REDACT_KEYS, type Level, type Logger } from './core';

export * from './core';

const RANK: Record<Level, number> = { info: 30, warn: 40, error: 50 };

function scrub(o: Record<string, unknown>): Record<string, unknown> {
  let out = o;
  for (const k of REDACT_KEYS) if (k in out) out = { ...out, [k]: '[redacted]' };
  return out;
}

function make(service: string, threshold: number, bindings: Record<string, unknown>): Logger {
  const emit = (lvl: Level, obj: object): void => {
    if (RANK[lvl] < threshold) return;
    // Date.now() is available on Workers (advances on I/O) — fine for a log timestamp.
    console.log(
      JSON.stringify(scrub({ lvl, svc: service, time: Date.now(), ...bindings, ...obj }))
    );
  };
  return {
    info: (o) => emit('info', o),
    warn: (o) => emit('warn', o),
    error: (o) => emit('error', o),
    child: (b) => make(service, threshold, { ...bindings, ...b }),
  };
}

export interface LoggerConfig {
  service: string;
  level?: Level; // defaults to 'info'
}

export function createLogger(cfg: LoggerConfig): Logger {
  return make(cfg.service, RANK[cfg.level ?? 'info'], {});
}
