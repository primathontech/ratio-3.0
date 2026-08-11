// Audit-trail read (ADR-016 Phase 1): powers the dashboard's "Recent changes". Split out of app.ts.
import { Hono } from 'hono';
import { requireMembership } from '../auth';
import { recentAudit } from '../audit';
import type { Vars } from '../types';

export function auditRoutes(): Hono<Vars> {
  const r = new Hono<Vars>();

  // Membership-gated; a read, so not itself audited.
  r.get('/stores/:id/audit', requireMembership, async (c) => {
    const entries = await recentAudit(c.req.param('id'));
    return c.json({ entries });
  });

  return r;
}
