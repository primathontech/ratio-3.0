// Agent-token minting (ADR-007 / OFCE-399): the owner delegates the AI agent scoped access to the
// same API. Split out of app.ts per Hono's app.route().
import { Hono } from 'hono';
import { requireRole, mintAgentToken } from '../auth';
import type { Vars } from '../types';

export function agentTokenRoutes(): Hono<Vars> {
  const r = new Hono<Vars>();

  // Membership-gated; scope is exactly this tenant and inherits the caller's principal — it can
  // only narrow, never widen.
  r.post('/stores/:id/agent-tokens', requireRole('owner'), (c) => {
    // Only a first-party human session may mint (M5): letting an agent token mint fresh agent
    // tokens would defeat the short-lived guarantee — a single leaked token could renew itself
    // indefinitely. Agent tokens carry a scope; human Clerk sessions don't.
    if (c.get('scope')) {
      return c.json({ error: 'agent tokens cannot mint agent tokens' }, 403);
    }
    const expiresIn = 3600;
    const token = mintAgentToken({
      sub: c.get('userId'),
      scope: [c.req.param('id')],
      exp: Math.floor(Date.now() / 1000) + expiresIn,
    });
    return c.json({ token, scope: [c.req.param('id')], expiresIn }, 201);
  });

  return r;
}
