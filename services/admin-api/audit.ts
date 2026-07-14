import type { MiddlewareHandler } from 'hono';
import { pool } from '../../packages/shared/db';
import { scopeFor } from './scopes';

// ADR-016 Phase 1 (OFCE-401): write one audit row per authenticated control-plane
// mutation. Runs AFTER the handler (needs the response status) and AFTER authMiddleware
// (needs the resolved identity). Reads and unauthenticated attempts are not recorded —
// the latter never set a userId, so there's no actor to attribute.

type Vars = { Variables: { userId: string; scope?: string[]; auditTenant?: string } };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface AuditEntry {
  actor: string;
  actorKind: 'user' | 'agent';
  tenantId: string | null;
  action: string;
  method: string;
  path: string;
  status: number;
}

export async function recordAudit(e: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (actor, actor_kind, tenant_id, action, method, path, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.actor, e.actorKind, e.tenantId, e.action, e.method, e.path, e.status]
  );
}

export const auditMiddleware: MiddlewareHandler<Vars> = async (c, next) => {
  await next();
  if (!MUTATING.has(c.req.method)) return;
  const actor = c.get('userId');
  if (!actor) return; // unauthenticated (already 401) — nothing to attribute

  const routePath = c.req.routePath;
  // A handler may set auditTenant when the tenant isn't a :id path param (e.g. onboarding,
  // where the new store id is in the body).
  const tenantId = c.get('auditTenant') ?? c.req.param('id') ?? null;
  try {
    await recordAudit({
      actor,
      actorKind: c.get('scope') ? 'agent' : 'user',
      tenantId,
      action: scopeFor(c.req.method, routePath) ?? `${c.req.method} ${routePath}`,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
    });
  } catch {
    // Audit is best-effort at this layer — a logging failure must not fail a request whose
    // action already succeeded. Phase 2 (OFCE-402) moves this to a durable/queued sink.
  }
};
