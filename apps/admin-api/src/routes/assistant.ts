import type { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { RatioControlPlane } from '@ratio/control-plane-client';
import { denyNarrowedScope, mintAgentToken } from '../middleware/auth';
import { idempotencyKeyFor } from '../middleware/idempotency';
import { runAssistant, scopeForAssistant } from '../services/assistant';
import type { RouteDeps, Vars } from './deps';

export function registerAssistantRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { idem, viaSelf } = deps;

  app.post('/assistant', denyNarrowedScope, async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return c.json({ error: 'AI assistant is not configured (ANTHROPIC_API_KEY missing).' }, 503);
    }
    const { message, storeId, idempotencyKey } = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      storeId?: string;
      idempotencyKey?: string;
    };
    if (!message || !message.trim()) return c.json({ error: 'message is required' }, 400);

    // Dedupe by idempotency key (OFCE-412): a retry / refresh / double-submit re-uses the
    // first run instead of firing the tool loop again and duplicating stores/pages. A client
    // key (header or body) wins; otherwise fall back to a content-derived key (L-2) so callers
    // that send no key still get dedup on an identical resubmit. Scoped per user throughout.
    const rawKey = c.req.header('idempotency-key') || idempotencyKey;
    const idemKey = idempotencyKeyFor({
      userId: c.get('userId'),
      storeId,
      message,
      clientKey: rawKey,
    });

    const result = await idem.run(idemKey, () => {
      // Least privilege (N1): scope the token to the open store when there is one; only the
      // onboarding entry point (no storeId) gets '*' so it can create a brand-new store.
      const token = mintAgentToken({
        sub: c.get('userId'),
        scope: scopeForAssistant(storeId),
        exp: Math.floor(Date.now() / 1000) + 900,
      });
      const client = new RatioControlPlane({
        baseUrl: new URL(c.req.url).origin,
        token,
        fetch: viaSelf,
      });
      return runAssistant({ anthropic: new Anthropic(), client, message, storeId });
    });
    return c.json(result);
  });
}
