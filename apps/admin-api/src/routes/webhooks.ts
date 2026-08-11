// Commerce webhook (gokwik → cache invalidation). Public + HMAC-verified. Split out of app.ts per
// Hono's app.route(). The auth middleware exempts /webhooks/commerce (it's server-to-server, HMAC).
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Vars } from '../types';

export interface WebhooksDeps {
  purgeEdgeTags: (tags: string[]) => Promise<void>;
}

// Map a gokwik change event → the surrogate tags the origin stamps on rendered pages (prod:<id> for
// products, col:<handle> for collections), so a product/price/collection edit purges exactly the
// cached storefront pages that showed that data.
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

export function webhookRoutes(deps: WebhooksDeps): Hono<Vars> {
  const { purgeEdgeTags } = deps;
  const r = new Hono<Vars>();

  r.post('/webhooks/commerce', async (c) => {
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

  return r;
}
