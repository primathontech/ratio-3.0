// Origin logging. The FOUNDATION (pino, correlation, redaction, classifyError) lives in the shared
// @ratio/observability package; this file only builds the origin's logger and defines the origin's
// DOMAIN events. Other apps do the same with their own events; the edge uses @ratio/observability/edge.
import { createLogger, classifyError, type Logger } from '@ratio/observability';

export { requestLog } from '@ratio/observability';
export type ReqLog = Logger;

// An APP may read env (ADR-0001 — the package takes `level` as injected config, reads no process.env).
export const logger = createLogger({ service: 'origin', level: process.env.LOG_LEVEL });

// ── origin domain events. Typed helpers pick their fields explicitly (a runtime allowlist). ──

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
