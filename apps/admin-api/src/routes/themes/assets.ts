import type { Context, Hono } from 'hono';
import {
  DraftConflict,
  bundleId,
  readAssetManifest,
  writeAssetManifest,
} from '@ratio/builder-core';
import { requireMembership } from '../../middleware/auth';
import type { RouteDeps, Vars } from '../deps';

// Binary asset upload limits (OFCE-645). MAX_ASSET_BYTES is the exact per-file cap the upload handler
// enforces; the request-body limit is a bit higher to leave room for multipart overhead (the boundary
// + the `path` field). isAssetUploadPath lets the global 1 MB body limit step aside for exactly these
// two routes — everything else stays at 1 MB.
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const ASSET_UPLOAD_BODY_LIMIT = MAX_ASSET_BYTES + 64 * 1024;
export const isAssetUploadPath = (path: string) =>
  /\/theme\/bundle\/assets$/.test(path) || /\/themes\/[^/]+\/assets$/.test(path);

export function registerThemeAssetsRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { themes, mainThemeId, ensureStoreTheme, assertThemeInStore, bundle503 } = deps;

  // Upload a binary theme asset (OFCE-645) into the theme's DRAFT. The bytes go to the content-hash
  // asset store; the draft's config/assets.json manifest gains an entry (path → hash/type/size), so the
  // asset ships + freezes with the theme on the next publish. A member edit (like draft-save).
  //
  // HARD content-type allowlist — only non-scriptable image/font types. svg/html/js are REJECTED: they
  // would be served from the storefront origin and, with an attacker-chosen MIME, could execute as
  // stored XSS. The origin also serves assets with X-Content-Type-Options: nosniff (PR3) as defense in
  // depth. contentType comes from the multipart part and is the merchant's claim — the allowlist is the
  // gate; a mislabeled file just renders broken, never runs.
  const ASSET_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'font/woff2',
  ]);
  // A safe relative asset path the theme references: dot/word segments, no leading slash, no traversal.
  const ASSET_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
  // '.'/'..' are path navigation (meaningless + traversal-shaped as asset names); __proto__/constructor
  // /prototype are prototype-pollution vectors as manifest keys. The regex allows dots (for extensions),
  // so these must be rejected as whole SEGMENTS explicitly.
  const RESERVED_SEG = new Set(['.', '..', '__proto__', 'constructor', 'prototype']);

  async function uploadAsset(c: Context<Vars>, themeId: string, ensure?: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.['file'];
    const path = String(form?.['path'] ?? '').trim();
    if (!(file instanceof File))
      return c.json({ error: 'file is required (multipart form-data)' }, 400);
    if (!ASSET_PATH_RE.test(path) || path.split('/').some((seg) => RESERVED_SEG.has(seg)))
      return c.json({ error: 'invalid asset path' }, 400);
    if (!ASSET_CONTENT_TYPES.has(file.type))
      return c.json({ error: `unsupported content-type '${file.type}'` }, 415);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: 'empty file' }, 400);
    if (bytes.byteLength > MAX_ASSET_BYTES)
      return c.json({ error: `file exceeds ${MAX_ASSET_BYTES} bytes` }, 413);

    if (ensure) await ensure();
    const ref = { themeId, tenantId: id };
    const entry = await themes.putAsset(ref, bytes, file.type);
    // Read-modify-write the draft manifest under optimistic concurrency: derive the expected revision
    // from the SAME overrides we read (never a second read that could race), and retry a couple times
    // if a concurrent draft-save moved it — so an upload can't silently clobber a code edit.
    for (let attempt = 0; ; attempt++) {
      const overrides = await themes.readDraft(ref);
      const manifest = readAssetManifest(overrides);
      manifest[path] = entry;
      const next = writeAssetManifest(overrides, manifest);
      try {
        await themes.saveDraft(ref, next, { expectedRevision: bundleId(overrides) });
        break;
      } catch (e) {
        if (e instanceof DraftConflict && attempt < 2) continue;
        if (e instanceof DraftConflict)
          return c.json({ error: 'conflict', currentRevision: e.actual }, 409);
        throw e;
      }
    }
    c.set('auditTenant', id);
    return c.json({ ok: true, path, asset: entry });
  }

  // List the theme's binary assets (OFCE-632): the draft manifest entries the editor's Assets view shows.
  // Member read, like draftGet. Reads the DRAFT's manifest (where uploadAsset writes) — the base ships no
  // binary assets, so this is the full set. Sorted by path for a stable UI.
  async function listAssets(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const manifest = readAssetManifest(
      await themes.readDraft({ themeId, tenantId: c.req.param('id')! })
    );
    const assets = Object.keys(manifest)
      .sort()
      .map((path) => ({ path, ...manifest[path] }));
    return c.json({ assets });
  }

  // Delete a binary asset (OFCE-632): drop its manifest entry from the DRAFT so it stops shipping on the
  // next publish. The content-addressed BYTES are intentionally KEPT — they are immutable and still
  // referenced by any already-published version's frozen manifest (and possibly another path via dedup);
  // deleting them would break old live/rolled-back versions. Same read-modify-write + CAS retry as upload.
  async function deleteAsset(c: Context<Vars>, themeId: string, ensure?: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const path = String(c.req.query('path') ?? '').trim();
    if (!path) return c.json({ error: 'path is required (?path=)' }, 400);
    if (ensure) await ensure();
    const ref = { themeId, tenantId: id };
    for (let attempt = 0; ; attempt++) {
      const overrides = await themes.readDraft(ref);
      const manifest = readAssetManifest(overrides);
      // Object.hasOwn (not `manifest[path]` truthiness): a path like '__proto__' would read the prototype
      // and skip the 404 — an own-key check is both correct and prototype-safe.
      if (!Object.hasOwn(manifest, path)) return c.json({ error: 'no such asset' }, 404);
      delete manifest[path];
      const next = writeAssetManifest(overrides, manifest);
      try {
        await themes.saveDraft(ref, next, { expectedRevision: bundleId(overrides) });
        break;
      } catch (e) {
        if (e instanceof DraftConflict && attempt < 2) continue;
        if (e instanceof DraftConflict)
          return c.json({ error: 'conflict', currentRevision: e.actual }, 409);
        throw e;
      }
    }
    c.set('auditTenant', id);
    return c.json({ ok: true, path });
  }

  // Legacy one-theme-per-store mounts (back-compat: the current editor + its tests). themeId = default.
  app.post('/stores/:id/theme/bundle/assets', requireMembership, (c) =>
    uploadAsset(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );
  app.get('/stores/:id/theme/bundle/assets', requireMembership, (c) =>
    listAssets(c, mainThemeId(c.req.param('id')))
  );
  app.delete('/stores/:id/theme/bundle/assets', requireMembership, (c) =>
    deleteAsset(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );

  // Theme-scoped asset mounts (multi-theme). assertThemeInStore enforces ownership on each.
  app.post('/stores/:id/themes/:themeId/assets', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return uploadAsset(c, c.req.param('themeId'));
  });
  app.get('/stores/:id/themes/:themeId/assets', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return listAssets(c, c.req.param('themeId'));
  });
  app.delete('/stores/:id/themes/:themeId/assets', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return deleteAsset(c, c.req.param('themeId'));
  });
}
