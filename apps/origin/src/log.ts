// Origin observability (ADR-0002, tier 1). Structured logging via pino — the standard Node logger:
// levels, an injectable async destination, a per-event timestamp, and field redaction as a backstop.
// Emitted as JSON to stdout (12-factor: one event stream; the platform/aggregator routes + alerts off
// the `lvl` field, not the stream). Every event carries a per-request `reqId` bound on a child logger,
// so all lines for one request group together and correlate with the edge's access log.
//
// SAFETY — a fixed field *schema* does NOT bound field *content*. Untrusted upstream text (a commerce
// backend's raw error `message`, a fetch error's URL) must NEVER be logged verbatim: it can carry a
// token, an email, or a credentialed URL. So commerce errors are mapped to a CLOSED taxonomy (a code +
// the error's type name) and the raw message is dropped. `redact` is defense-in-depth on top.
import pino, { type Logger, type DestinationStream } from 'pino';

export type ReqLog = Logger;

// The base logger. `dest` is injectable so tests capture output without monkeypatching a global.
export function createLogger(dest?: DestinationStream): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { svc: 'origin' }, // drop pino's pid/hostname noise; ECS already tags the stream
      formatters: { level: (label) => ({ lvl: label }) }, // emit `lvl:"info"`, matching the edge
      // Backstop only — events below are built from closed field sets, but redact secret-bearing
      // keys in case a future call site spreads one in.
      redact: {
        paths: ['token', 'cookie', 'authorization', 'password', 'secret'],
        censor: '[redacted]',
      },
    },
    dest
  );
}

export const logger: Logger = createLogger();

// Per-request child: binds reqId so every line for a request correlates (and ties to the edge trace).
export function requestLog(base: Logger, reqId: string): ReqLog {
  return base.child({ reqId });
}

// ── Typed commerce events. Each helper EXPLICITLY picks its fields (a runtime allowlist, not only a
// compile-time type), so no caller can spread an extra/sensitive field into a line. ──

export function logCartAdd(
  log: ReqLog,
  e: { tenant: string; ok: boolean; variant: string; lines: number }
): void {
  // lines = the count the backend echoed: 0 = it took the call but added nothing (wrong variant id).
  log[e.ok ? 'info' : 'warn']({
    evt: 'cart_add',
    tenant: e.tenant,
    ok: e.ok,
    variant: e.variant,
    lines: e.lines,
  });
}

export function logCartUpdate(
  log: ReqLog,
  e: { tenant: string; ok: boolean; variant: string }
): void {
  log[e.ok ? 'info' : 'warn']({
    evt: 'cart_update',
    tenant: e.tenant,
    ok: e.ok,
    variant: e.variant,
  });
}

export function logCheckout(log: ReqLog, e: { tenant: string; ok: boolean }): void {
  log[e.ok ? 'info' : 'warn']({ evt: 'checkout', tenant: e.tenant, ok: e.ok });
}

export type CommerceOp = 'add' | 'update' | 'get' | 'checkout';

export function logCommerceError(log: ReqLog, op: CommerceOp, tenant: string, err: unknown): void {
  const { code, errType } = classifyError(err);
  log.error({ evt: 'commerce_error', tenant, op, code, errType });
}

// Map any thrown error to a CLOSED taxonomy + its type name — never the raw (untrusted) message.
export function classifyError(e: unknown): { code: string; errType: string } {
  const err = e instanceof Error ? e : new Error(String(e));
  const errType = err.name || 'Error';
  const code = (err as { code?: unknown }).code;
  const msg = err.message || '';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  )
    return { code: 'network', errType };
  if (err.name === 'AbortError' || /timeout|timed out|aborted/i.test(msg))
    return { code: 'timeout', errType };
  if (/cart data missing/i.test(msg)) return { code: 'empty_response', errType };
  if (/cart operation failed/i.test(msg)) return { code: 'backend_rejected', errType };
  return { code: 'backend_error', errType };
}
