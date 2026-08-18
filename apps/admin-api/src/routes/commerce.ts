import type { Hono } from 'hono';
import { forTenant } from '@ratio/data-repo';
import { buildCustomClient, commerceUrlsFromEnv, tenantTag } from '@ratio/builder-core';
import { interpretCollectionsEnvelope } from '../services/commerce-verify';
import { requireMembership, requireRole, denyNarrowedScope } from '../middleware/auth';
import type { RouteDeps, Vars } from './deps';

export function registerCommerceRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { purgeEdgeTags, purgeStoreUrls, pbStore } = deps;

  // Verify a commerce merchant id BEFORE a store exists (the onboarding wizard's step 1, OFCE-618).
  // Store-less: build a commerce client from the id alone + the env service URLs and ping the backend
  // (getCollections). We return a shape the UI can act on rather than a bare bool:
  //   - configured=false  → the commerce backend isn't wired in this environment (e.g. local dev) →
  //                          the wizard soft-passes ("can't verify here") instead of blocking.
  //   - verified=true + collectionCount → the id reached a real backend (count>0 is strong proof;
  //                          count=0 means reachable-but-empty, which the UI flags as "double-check").
  //   - verified=false    → the backend errored/rejected the id (unknown or inactive merchant).
  // No membership gate (there's no store yet); denyNarrowedScope keeps it to full onboarding sessions.
  app.post('/commerce/verify', denyNarrowedScope, async (c) => {
    const { merchantId } = (await c.req.json().catch(() => ({}))) as { merchantId?: string };
    const mid = String(merchantId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(mid)) {
      return c.json({ error: 'a valid merchantId is required' }, 400);
    }
    const urls = commerceUrlsFromEnv(process.env);
    const client = urls ? buildCustomClient({ merchantId: mid }, urls) : null;
    if (!client) {
      console.warn(
        '[commerce/verify] not configured — set COMMERCE_PRODUCT_API_URL, COMMERCE_CART_API_URL and COMMERCE_ORDER_API_URL (base URLs, no /api/v1 suffix)'
      );
      return c.json({ configured: false, verified: false });
    }
    try {
      // Fetch just ONE collection: verify only needs "does this merchant have any", and the backend
      // returns the true total in meta.pagination.total regardless of the page size — so first:1 is
      // the minimal call. The client resolves { success:false } rather than throwing on a bad id /
      // down backend, so the envelope decides verified — not the try/catch (a hard client throw only).
      const res = await client.getCollections({ first: 1 });
      const result = interpretCollectionsEnvelope(res);
      if (!result.verified) {
        // Surface WHY the backend didn't verify (unknown/inactive merchant, wrong base URL → 404, …)
        // instead of returning a silent verified:false.
        const env = res as { message?: string; error?: { message?: string } } | null;
        console.warn(
          `[commerce/verify] merchant ${mid} not verified: ${env?.error?.message ?? env?.message ?? 'backend returned no successful collections envelope'}`
        );
      }
      return c.json(result);
    } catch (e) {
      console.error(
        `[commerce/verify] request threw for merchant ${mid}:`,
        e instanceof Error ? e.message : e
      );
      return c.json({ configured: true, verified: false });
    }
  });

  // Commerce backend connection: the GoKwik merchant id that powers products/collections/cart.
  app.get('/stores/:id/commerce', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ merchantId: tenant.commerce?.merchantId ?? '' });
  });

  // Connect/update (or disconnect with an empty id) the commerce backend. Owner-only. Purge the
  // store's pages — product/collection data is baked into the cached shells.
  app.put('/stores/:id/commerce', requireRole('owner'), async (c) => {
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { merchantId?: string };
    const merchantId = String(body.merchantId ?? '').trim();
    await forTenant(id).setCommerce(merchantId ? { merchantId } : null);
    await purgeEdgeTags([tenantTag(id)]); // local dev edge-sim (by tag)
    const pages = await pbStore.listPages(id);
    const edgePurged = await purgeStoreUrls(
      id,
      pages.map((p) => p.path)
    );
    c.set('auditTenant', id);
    return c.json({ ok: true, merchantId, ...(edgePurged !== null && { edgePurged }) });
  });
}
