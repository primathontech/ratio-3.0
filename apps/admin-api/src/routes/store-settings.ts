// Store settings routes — theme, theme versions (ADR-013 §13), commerce backend, collections.
// Split out of app.ts per Hono's "scale with app.route()" best practice; handlers stay inline
// (Hono best-practice #1 — path params infer). Shared singletons/helpers arrive as `deps` so this
// module owns no process state.
import { Hono } from 'hono';
import { forTenant } from '@ratio/data-repo';
import {
  tenantTag,
  FONTS,
  BASE_SIZE,
  RADIUS,
  CONTAINER,
  commerceUrlsFromEnv,
  buildCustomClient,
  ThemeConflict,
  type ThemeTokens,
  type PgPageStore,
  type PgThemeStore,
} from '@ratio/builder-core';
import { requireMembership, requireRole } from '../auth';
import type { Vars } from '../types';

export interface StoreSettingsDeps {
  pbStore: PgPageStore;
  themeStore: PgThemeStore;
  purgeEdgeTags: (tags: string[]) => Promise<void>;
  purgeStoreUrls: (id: string, paths: string[]) => Promise<boolean | null>;
}

// Validate a theme at the boundary: brand colour is free-form hex, every other knob must be a key
// of its fixed scale. Reject anything off-scale (don't silently drop) so the editor surfaces it.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function validateTheme(input: unknown): ThemeTokens {
  if (!input || typeof input !== 'object') throw new Error('theme must be an object');
  const t = input as Record<string, unknown>;
  const pick = (key: string, scale: Record<string, string>): string | undefined => {
    const v = t[key];
    if (v == null) return undefined;
    if (typeof v !== 'string' || !(v in scale)) throw new Error(`invalid ${key}`);
    return v;
  };
  if (t.color != null && (typeof t.color !== 'string' || !HEX.test(t.color)))
    throw new Error('color must be a hex value');
  return {
    color: typeof t.color === 'string' ? t.color : undefined,
    bodyFont: pick('bodyFont', FONTS),
    headingFont: pick('headingFont', FONTS),
    baseSize: pick('baseSize', BASE_SIZE),
    radius: pick('radius', RADIUS),
    container: pick('container', CONTAINER),
  };
}

export function storeSettingsRoutes(deps: StoreSettingsDeps): Hono<Vars> {
  const { pbStore, themeStore, purgeEdgeTags, purgeStoreUrls } = deps;
  const r = new Hono<Vars>();

  // The store's collections, for the editor's collection picker. Builds the tenant's commerce client
  // (env service URLs + the tenant's own merchantId) and returns the CANONICAL collections envelope-
  // navigated only — no shaping here (the SPA maps to {handle,title}). Empty when not connected.
  r.get('/stores/:id/collections', requireMembership, async (c) => {
    const urls = commerceUrlsFromEnv(process.env);
    if (!urls) return c.json({ collections: [] });
    const tenant = await forTenant(c.req.param('id')).getTenant();
    const client = buildCustomClient(tenant?.commerce, urls);
    if (!client) return c.json({ collections: [] });
    const res = await client.getCollections({ first: 100 });
    const data = res?.data;
    const collections = Array.isArray(data) ? data : (data?.collections ?? []);
    return c.json({ collections });
  });

  // The store's storefront theme (global style knobs) — read by the Theme Settings panel.
  r.get('/stores/:id/theme', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ theme: tenant.theme ?? {} });
  });

  // Save the theme. Validated against the fixed scales, persisted, then the tenant's pages are
  // purged — the theme is baked into every cached shell, so a change invalidates all of them.
  r.put('/stores/:id/theme', requireMembership, async (c) => {
    const id = c.req.param('id');
    let theme: ThemeTokens;
    try {
      theme = validateTheme(await c.req.json().catch(() => ({})));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'invalid theme' }, 400);
    }
    await forTenant(id).setTheme(theme);
    await purgeEdgeTags([tenantTag(id)]); // local dev edge-sim (by tag)
    // Prod: theme is baked into every page's shell, so purge all the store's page URLs.
    const pages = await pbStore.listPages(id);
    const edgePurged = await purgeStoreUrls(
      id,
      pages.map((p) => p.path)
    );
    c.set('auditTenant', id);
    return c.json({ ok: true, theme, ...(edgePurged !== null && { edgePurged }) });
  });

  // Theme version history + the current published pointer (ADR-013 §13).
  r.get('/stores/:id/theme/versions', requireMembership, async (c) => {
    const id = c.req.param('id');
    const [versions, published] = await Promise.all([
      themeStore.listVersions(id),
      themeStore.publishedVersion(id),
    ]);
    return c.json({ published, versions });
  });

  // Publish the whole theme atomically (promote drafts→live + snapshot an immutable version).
  // Owner-only. `expectedBase` (the version the editor loaded) enables optimistic concurrency → 409.
  r.post('/stores/:id/theme/publish', requireRole('owner'), async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      note?: string;
      expectedBase?: number | null;
    };
    let result: { version: number };
    try {
      result = await themeStore.publishTheme(id, {
        by: c.get('userId'),
        note: body.note,
        expectedBase: body.expectedBase,
      });
    } catch (e) {
      if (e instanceof ThemeConflict)
        return c.json({ error: e.message, expected: e.expected, actual: e.actual }, 409);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    const pages = await pbStore.listPages(id);
    const edgePurged = await purgeStoreUrls(
      id,
      pages.map((p) => p.path)
    );
    c.set('auditTenant', id);
    return c.json({
      ok: true,
      version: result.version,
      ...(edgePurged !== null && { edgePurged }),
    });
  });

  // Roll back to an earlier published version (repoint + restore live state). Owner-only.
  r.post('/stores/:id/theme/rollback', requireRole('owner'), async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number')
      return c.json({ error: 'version (number) is required' }, 400);
    let result: { version: number };
    try {
      result = await themeStore.rollbackTheme(id, body.version);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'rollback failed' }, 404);
    }
    await purgeEdgeTags([tenantTag(id)]);
    const pages = await pbStore.listPages(id);
    const edgePurged = await purgeStoreUrls(
      id,
      pages.map((p) => p.path)
    );
    c.set('auditTenant', id);
    return c.json({
      ok: true,
      version: result.version,
      ...(edgePurged !== null && { edgePurged }),
    });
  });

  // Commerce backend connection: the GoKwik merchant id that powers products/collections/cart.
  r.get('/stores/:id/commerce', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ merchantId: tenant.commerce?.merchantId ?? '' });
  });

  // Connect/update (or disconnect with an empty id) the commerce backend. Owner-only. Purge the
  // store's pages — product/collection data is baked into the cached shells.
  r.put('/stores/:id/commerce', requireRole('owner'), async (c) => {
    const id = c.req.param('id');
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

  return r;
}
