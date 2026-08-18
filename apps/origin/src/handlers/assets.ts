import { type Context } from 'hono';
import { forTenant } from '@ratio/data-repo';
import { readAssetManifest, isAssetHash, ThemeStore } from '@ratio/builder-core';
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
          c.header('content-type', entry.contentType);
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
