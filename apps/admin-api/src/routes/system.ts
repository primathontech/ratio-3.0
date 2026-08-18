import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { isPlatformAdmin } from '../middleware/auth';
import { openApiDocument } from '../openapi';
import { config } from '../config';
import type { RouteDeps, Vars } from './deps';

// Commerce webhook: map a gokwik change event → the surrogate tags the origin stamps on rendered
// pages (prod:<id> for products, col:<handle> for collections), so a product/price/collection edit
// purges exactly the cached storefront pages that showed that data.
function tagsForCommerceEvent(type: string, data: Record<string, unknown>): string[] {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  switch (type) {
    case 'product.updated':
    case 'product.created':
    case 'product.deleted':
      return data.productId != null ? [`prod:${data.productId}`] : [];
    case 'products.bulk_updated':
    case 'inventory.updated':
    case 'pricing.updated':
      return ids(data.productIds).map((id) => `prod:${id}`);
    case 'collection.updated':
    case 'collection.created':
    case 'collection.deleted':
      return data.handle ? [`col:${data.handle}`] : [];
    default:
      return [];
  }
}

// HMAC-SHA256 over the RAW body (re-serializing would change the bytes the sender signed).
function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerSystemRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { purgeEdgeTags, readiness } = deps;

  // Public liveness root — the ECS Express gateway health-checks GET / and expects 200.
  app.get('/', (c) => c.json({ service: 'ratio-admin-api', status: 'ok' }));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  // Readiness (vs liveness /health): probe the DB so an orchestrator doesn't route traffic
  // to an instance that can't reach Postgres. Pre-auth so probes need no credentials (L-7).
  app.get('/ready', async (c) => {
    const ok = await readiness();
    return c.json({ status: ok ? 'ready' : 'unavailable' }, ok ? 200 : 503);
  });

  // The API contract (ADR-016), source of truth for the generated SDK. Public so tooling
  // and dev portals can read it without a token.
  app.get('/openapi.json', (c) => c.json(openApiDocument));

  // Who am I — also surfaces the caller's Clerk id (for PLATFORM_ADMIN_IDS setup).
  app.get('/me', (c) => {
    const userId = c.get('userId');
    // isLocal (RATIO_LOCAL) lets the SPA show dev-only affordances — e.g. a local storefront link
    // via the edge's ?store=<id> override — driven by the one run-environment flag, not a guess.
    return c.json({ userId, isPlatformAdmin: isPlatformAdmin(userId), isLocal: config.local });
  });

  // Commerce change webhook (gokwik → cache invalidation). Public + HMAC-verified. Maps the event
  // to the surrogate tags the origin stamped (prod:<id> / col:<handle>) and purges them, so a
  // product/price/collection change invalidates exactly the cached storefront pages that showed it.
  app.post('/webhooks/commerce', async (c) => {
    const raw = await c.req.text();
    const secret = process.env.WEBHOOK_SECRET;
    if (secret && !verifyWebhookSignature(raw, c.req.header('x-webhook-signature'), secret)) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    let body: { type?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!body.type) return c.json({ error: 'type is required' }, 400);
    const tags = tagsForCommerceEvent(body.type, body.data ?? {});
    await purgeEdgeTags(tags);
    return c.json({ ok: true, type: body.type, purged: tags });
  });
}
