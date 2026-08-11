// In-dashboard AI assistant (OFCE-400 Model A / ADR-014 D-STR7): Claude runs a server-side tool-use
// loop and drives the SAME control-plane the dashboard uses. Split out of app.ts per app.route().
// The per-call idempotency store + the in-process fetch (viaSelf) come from the composition root.
import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { RatioControlPlane } from '@ratio/control-plane-client';
import { denyNarrowedScope, mintAgentToken } from '../auth';
import { idempotencyKeyFor } from '../idempotency';
import { runAssistant, scopeForAssistant } from '../assistant';
import type { Vars } from '../types';

export interface AssistantDeps {
  idem: { run: <T>(key: string, work: () => Promise<T>) => Promise<T> };
  // in-process fetch routed back at THIS app, carrying the per-process internal marker so the
  // assistant's edits run through the same auth/membership/audit as everything else.
  viaSelf: typeof fetch;
}

export function assistantRoutes(deps: AssistantDeps): Hono<Vars> {
  const { idem, viaSelf } = deps;
  const r = new Hono<Vars>();

  r.post('/assistant', denyNarrowedScope, async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return c.json({ error: 'AI assistant is not configured (ANTHROPIC_API_KEY missing).' }, 503);
    }
    const { message, storeId, idempotencyKey } = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      storeId?: string;
      idempotencyKey?: string;
    };
    if (!message || !message.trim()) return c.json({ error: 'message is required' }, 400);

    // Dedupe by idempotency key (OFCE-412): a retry / refresh / double-submit re-uses the first run
    // instead of firing the tool loop again and duplicating stores/pages. A client key (header or
    // body) wins; otherwise fall back to a content-derived key (L-2). Scoped per user throughout.
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

  return r;
}
