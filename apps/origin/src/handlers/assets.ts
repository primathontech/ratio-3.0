import { type Context } from 'hono';
import { forTenant } from '@ratio/data-repo';
import {
  readAssetManifest,
  isAssetHash,
  safeAssetContentType,
  tenantTag,
  ThemeStore,
  resolveThemeTokens,
  webManifest,
  SERVICE_WORKER_PATH,
} from '@ratio/builder-core';
import { type Vars } from './helpers';

export type AssetsDeps = {
  themeStore: ThemeStore | null;
  islandsUrl: string;
  islandsJs: string;
};

export async function handleAssets(c: Context<Vars>, deps: AssetsDeps): Promise<Response> {
  const { themeStore, islandsUrl, islandsJs } = deps;
  const path = new URL(c.req.url).pathname;
  c.header('x-content-type-options', 'nosniff');
  if (path === islandsUrl) {
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'public, max-age=31536000, immutable');
    c.header('x-cache', 'long');
    return c.body(islandsJs);
  }
  // A theme binary asset (OFCE-646): /assets/<hash> — content-addressed, so it's immutable and
  // CDN-cacheable forever. Resolve the store's LIVE theme + manifest, verify the hash is an asset
  // the live theme actually references (never an arbitrary blob in the bucket), and serve the bytes
  // with the manifest's validated content-type + nosniff (already set). Any miss → the JS-safe 404.
  const assetTenant = c.req.header('x-ratio-tenant');
  const hash = path.slice('/assets/'.length).split(/[./]/)[0]; // /assets/<hash> or /assets/<hash>.<ext>
  if (themeStore && assetTenant && isAssetHash(hash)) {
    // Check the live manifest FIRST (its compiled bundle is content-hash LRU-cached), so a bogus but
    // valid-hex hash 404s after only the cached lookup — it never reaches the getTenant DB read or an
    // S3 byte fetch. Only a hash the live theme actually references pays for those.
    const compiled = await themeStore.loadLiveCompiled(assetTenant).catch(() => null);
    const entry = compiled
      ? Object.values(readAssetManifest(compiled)).find((e) => e.hash === hash)
      : undefined;
    if (entry) {
      const tenant = await forTenant(assetTenant)
        .getTenant()
        .catch(() => null);
      if (tenant && tenant.status === 'active' && tenant.liveThemeId) {
        // No in-memory byte cache here (unlike the compiled bundle): assets can be multi-MB, and the
        // immutable cache-control means the edge caches them after the first fetch — so the origin
        // does at most one cold S3 read per asset, never a growing memory footprint.
        const bytes = await themeStore
          .getAsset({ themeId: tenant.liveThemeId, tenantId: assetTenant }, hash)
          .catch(() => null);
        if (bytes) {
          // The manifest content-type is merchant-editable → untrusted. Neutralize a non-allowlisted
          // type to octet-stream so a tampered entry can't be served as active HTML/JS (and then CDN-
          // cached immutable) on the public storefront. nosniff is already set above.
          c.header('content-type', safeAssetContentType(entry.contentType));
          c.header('cache-control', 'public, max-age=31536000, immutable');
          c.header('x-cache', 'long');
          c.header('x-handler', 'theme-asset');
          // c.body wants an ArrayBuffer, not a Uint8Array view — slice() gives a right-sized copy.
          return c.body(bytes.slice().buffer as ArrayBuffer);
        }
      }
    }
  }
  c.header('x-cache', 'no-store');
  return c.text('404 — not found', 404);
}

// Well-known root paths (OFCE-631): browsers request /favicon.ico by default (even with no <link>), and
// a PWA fetches /manifest.json — serve both from the store's LIVE theme so a real storefront doesn't 404
// on them. /favicon.ico is a binary asset (looked up by its manifest path); /manifest.json rides the
// bundle as TEXT (application/json isn't an allowed binary-asset type). Unlike the immutable content-
// addressed /assets/<hash>, these are STABLE URLs whose bytes change when the merchant re-uploads/edits,
// so they carry a short max-age (a change self-heals within the hour), never `immutable`.
export async function handleWellKnown(c: Context<Vars>, deps: AssetsDeps): Promise<Response> {
  const { themeStore } = deps;
  const path = new URL(c.req.url).pathname;
  c.header('x-content-type-options', 'nosniff');
  const assetTenant = c.req.header('x-ratio-tenant');
  const compiled =
    themeStore && assetTenant
      ? await themeStore.loadLiveCompiled(assetTenant).catch(() => null)
      : null;
  // Same suspended-store contract as /assets and the storefront (OFCE-410): only an ACTIVE tenant with a
  // live theme serves content — a suspended/unknown store 404s, never revealing it exists.
  const tenant =
    compiled && assetTenant
      ? await forTenant(assetTenant)
          .getTenant()
          .catch(() => null)
      : null;
  if (compiled && assetTenant && tenant && tenant.status === 'active' && tenant.liveThemeId) {
    // These paths are mutable (a re-upload/edit changes them), so they ride the store's tenant tag: a
    // theme publish enqueues a tenantTag purge, which now evicts a stale favicon/manifest at the edge
    // too — the short max-age is just the fallback bound, not the only one.
    const withTags = () => {
      c.header('cache-control', 'public, max-age=3600');
      c.header('x-surrogate-keys', tenantTag(assetTenant));
      c.header('x-handler', 'well-known');
    };
    if (path === '/manifest.json') {
      // Merge the synthesized defaults (store name + brand colour, from admin) with the theme's own
      // manifest.json (a file the merchant edits in the code editor). Authored keys win; name/theme_color
      // auto-fill from the store when the merchant hasn't set them. So every store is a valid PWA with no
      // separate form, and editing the file still works.
      const tokens = resolveThemeTokens(compiled, tenant.theme);
      const body = webManifest(
        { name: tenant.name, themeColor: tokens.color },
        compiled['manifest.json']
      );
      c.header('content-type', 'application/json; charset=utf-8');
      withTags();
      return c.body(body);
    } else if (path === '/sw.js') {
      // The service worker is OPT-IN: only a store whose theme ships sw.js gets one. Served at /sw.js
      // (root scope) as JS. No sw.js → fall through to the 404 below (no worker, strict CSP unchanged).
      const sw = compiled[SERVICE_WORKER_PATH];
      if (typeof sw === 'string') {
        c.header('content-type', 'text/javascript; charset=utf-8');
        withTags();
        return c.body(sw);
      }
    } else if (path === '/favicon.ico') {
      // The theme references a favicon under any path whose basename is favicon.ico (e.g. the editor
      // uploads assets under `assets/`), so match on the basename, not an exact key.
      const entry = Object.entries(readAssetManifest(compiled)).find(
        ([p]) => p === 'favicon.ico' || p.endsWith('/favicon.ico')
      )?.[1];
      if (entry) {
        const bytes = await themeStore!
          .getAsset({ themeId: tenant.liveThemeId, tenantId: assetTenant }, entry.hash)
          .catch(() => null);
        if (bytes) {
          // Untrusted merchant manifest content-type → neutralize a non-allowlisted type (same guard as
          // /assets/<hash>), so a tampered favicon entry can't be served as active HTML/JS.
          c.header('content-type', safeAssetContentType(entry.contentType));
          withTags();
          return c.body(bytes.slice().buffer as ArrayBuffer);
        }
      }
    }
  }
  // No active theme, or no favicon/manifest → a normal 404 (browsers handle a missing favicon fine).
  c.header('x-cache', 'no-store');
  return c.text('404 — not found', 404);
}
