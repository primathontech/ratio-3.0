import type { Context, Hono } from 'hono';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';
import {
  DraftConflict,
  layoutOwnsDocument,
  tenantTag,
  ThemeStore as BundleThemeStore,
} from '@ratio/builder-core';
import type { ThemeFiles } from '@ratio/builder-core';
import { requireMembership, requireRole } from '../../middleware/auth';
import type { RouteDeps, Vars } from '../deps';

// Publish: freeze compile(base ⊕ overrides), cut an immutable version, flip the live pointer.
// Full theme ownership invariant: a store's live theme MUST own the whole document — the origin
// renders the theme's layout/theme.liquid with no TS-shell fallback. The live pointer moves three ways
// (publish, activate, rollback); all three must refuse a theme whose layout is not a full HTML
// document, or the origin could be handed a body-only theme once the shell is gone. This checks an
// already-published version's FROZEN layout (activate/rollback); publishBundle checks the draft.
// Returns a 400 Response to short-circuit the route, or null to proceed.
export async function assertVersionOwnsDocument(
  themes: BundleThemeStore | null,
  c: Context<Vars>,
  tenantId: string,
  themeId: string,
  version?: number
): Promise<Response | null> {
  if (!themes) return null;
  // Full theme ownership (OFCE-641): the origin renders the live theme's layout with no shell fallback,
  // so the live theme MUST own the whole document. Enforce it on every path that can move the live
  // pointer (activate/rollback here; publish in publishBundle) — refuse to point live at a version
  // whose frozen layout is not a full HTML document.
  const { rows } = await pool.query<{ compiled_hash: string }>(
    version != null
      ? 'SELECT compiled_hash FROM theme_bundle_version WHERE theme_id = $1 AND version = $2'
      : 'SELECT compiled_hash FROM theme_bundle_version WHERE theme_id = $1 ORDER BY version DESC LIMIT 1',
    version != null ? [themeId, version] : [themeId]
  );
  const hash = rows[0]?.compiled_hash;
  if (!hash) return null; // no such version — setLive/rollback raises the precise 400/404
  const compiled = await themes.loadCompiled(tenantId, themeId, hash);
  // A published version with no loadable bundle is an infra fault (missing/corrupt S3 blob), NOT a
  // merchant content error — bubble it to onError (500 + logged) instead of blaming their layout.
  if (compiled == null)
    throw new Error(
      `compiled bundle missing for theme '${themeId}'@${version ?? 'latest'} (hash ${hash})`
    );
  if (!layoutOwnsDocument(compiled['layout/theme.liquid']))
    return c.json(
      {
        error:
          'that version’s layout/theme.liquid is not a full HTML document — it cannot be made live under full theme ownership',
      },
      400
    );
  return null;
}

// --- Bundle-theme authoring (OFCE-601 / OFCE-615, base ⊕ overrides). Distinct from the legacy Pg
// theme routes above: merchant Liquid theme files stored as S3 bundles. A store may keep several
// themes (OFCE-615); the legacy `/theme/bundle/*` paths edit the store's default theme (`${id}-main`),
// the new `/themes/:themeId/*` paths edit a named theme. All gated on BUNDLE_S3_BUCKET — 503 when the
// object store isn't wired.
export function registerBundleThemeRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const {
    themes,
    mainThemeId,
    ensureStoreTheme,
    assertThemeInStore,
    identityCompile,
    bundle503,
    purgeEdgeTags,
    renderThemePreview,
  } = deps;

  // The six editing handlers, parameterized by an explicit themeId so they mount at BOTH the legacy
  // one-theme-per-store paths (themeId = `${id}-main`) and the multi-theme `/themes/:themeId/*` paths.

  // Save a theme's draft overrides (only the files it changed). `ensure` provisions the store's
  // default theme on first save (legacy path); the multi-theme path passes none — the theme already
  // exists (assertThemeInStore ran).
  async function draftPut(c: Context<Vars>, themeId: string, ensure?: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as {
      files?: ThemeFiles;
      revision?: string;
    };
    // The editor always sends the revision it loaded; require it so a malformed/omitted body fails
    // loud (400) instead of a blind last-write-wins save.
    if (typeof body.revision !== 'string')
      return c.json({ error: 'revision is required to save a draft' }, 400);
    if (ensure) await ensure();
    // Store only the delta from the base (untouched files keep tracking base updates); reject the save
    // if another editor moved the draft first (409) instead of silently clobbering it.
    try {
      const { hash } = await themes.saveOverrides({ themeId, tenantId: id }, body.files ?? {}, {
        expectedRevision: body.revision,
      });
      c.set('auditTenant', id);
      return c.json({ ok: true, hash });
    } catch (e) {
      if (e instanceof DraftConflict)
        return c.json({ error: 'conflict', currentRevision: e.actual }, 409);
      throw e;
    }
  }

  // Read a theme's composed draft (base ⊕ overrides) + the revision token the editor round-trips.
  async function draftGet(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const [files, revision] = await Promise.all([
      themes.readComposed({ themeId, tenantId: id }),
      themes.draftRevision({ themeId, tenantId: id }),
    ]);
    return c.json({ files, revision });
  }

  // Ensure the theme opens populated instead of empty. A no-op (seeded:false) once it has content.
  async function scaffold(c: Context<Vars>, themeId: string, ensure: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const existing = await themes.readComposed({ themeId, tenantId: id });
    if (Object.keys(existing).length > 0)
      return c.json({
        files: existing,
        seeded: false,
        revision: await themes.draftRevision({ themeId, tenantId: id }),
      });
    await ensure();
    const [files, revision] = await Promise.all([
      themes.readComposed({ themeId, tenantId: id }),
      themes.draftRevision({ themeId, tenantId: id }),
    ]);
    c.set('auditTenant', id);
    return c.json({ files, seeded: true, revision });
  }

  // Live preview: render a page to HTML. Renders the POSTed in-flight buffer when given, else the saved
  // draft. A Liquid/template error is the merchant's own code → { error } (200), not a 500.
  async function preview(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { files?: ThemeFiles; page?: string };
    const files = body.files ?? (await themes.readComposed({ themeId, tenantId: id }));
    const page = body.page || 'index';
    try {
      const tenant = await forTenant(id).getTenant();
      const { html, sampleData } = await renderThemePreview(
        files,
        page,
        id,
        tenant?.commerce,
        tenant?.theme,
        tenant?.name
      );
      return c.json({ html, sampleData });
    } catch (e) {
      console.error('theme preview render failed:', e);
      return c.json({ error: e instanceof Error ? e.message : 'preview failed' });
    }
  }

  async function publishBundle(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    // Enforce the full-document invariant at this boundary (untrusted merchant/AI layout): refuse to
    // publish a composed theme whose layout is not a full HTML document — the origin renders it with no
    // shell fallback. The base is a full document, so this only trips a merchant who broke their own
    // layout. Skip an empty compose (no base + no draft) — a "nothing to publish" case publish() reports.
    const composed = await themes.readComposed({ themeId, tenantId: id });
    if (Object.keys(composed).length > 0 && !layoutOwnsDocument(composed['layout/theme.liquid']))
      return c.json(
        {
          error:
            'layout/theme.liquid must be a full HTML document (start with <!doctype or <html) before publishing',
        },
        400
      );
    // Publish does NOT create the theme — draft-save is the create point.
    let version: number;
    try {
      ({ version } = await themes.publish(
        { themeId, tenantId: id },
        { compile: identityCompile, by: c.get('userId') }
      ));
    } catch (e) {
      if (e instanceof Error && /unknown theme/.test(e.message))
        return c.json({ error: 'no draft to publish — save a draft first' }, 400);
      throw e; // infra faults (S3/DB) bubble to onError → 500 + logged, not a misleading 400
    }
    // publish() enqueued a durable tenant-tag purge in its txn; purgeEdgeTags hits the local edge-sim.
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ ok: true, version });
  }

  // Roll the live pointer back to an earlier published version of the store's live theme (the bundles
  // are all still in S3). Operates on the tenant's live pointer, so it takes no themeId.
  async function rollbackBundle(c: Context<Vars>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number')
      return c.json({ error: 'version (number) is required' }, 400);
    // Rolls the tenant's LIVE theme back to body.version — guard that version's layout (full theme
    // ownership) before repointing. Resolve the live theme id the rollback will move.
    const live = (
      await pool.query<{ live_theme_id: string | null }>(
        'SELECT live_theme_id FROM tenants WHERE id = $1',
        [id]
      )
    ).rows[0]?.live_theme_id;
    if (live) {
      const bad = await assertVersionOwnsDocument(themes, c, id, live, body.version);
      if (bad) return bad;
    }
    try {
      await themes.rollback(id, body.version);
    } catch (e) {
      if (e instanceof Error && /unknown version|no published theme|unknown tenant/.test(e.message))
        return c.json({ error: e.message }, 404);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ ok: true, version: body.version });
  }

  // Reset a theme's draft to pure base — drop every override (the merchant's customizations) so the
  // editor is back to the default theme. A member edit (like draft-save), not owner-only. Returns the
  // now-composed files + the fresh revision so the editor swaps its buffer in place.
  async function resetBundle(c: Context<Vars>, themeId: string, ensure?: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    // Ensure the theme row exists first (legacy main-theme mount) so reset can't write an orphan draft
    // blob for a never-created theme; the multi-theme mount skips this (assertThemeInStore proved it).
    if (ensure) await ensure();
    await themes.resetDraft({ themeId, tenantId: id });
    const [files, revision] = await Promise.all([
      themes.readComposed({ themeId, tenantId: id }),
      themes.draftRevision({ themeId, tenantId: id }),
    ]);
    c.set('auditTenant', id);
    return c.json({ ok: true, files, revision });
  }

  // Legacy one-theme-per-store mounts (back-compat: the current editor + its tests). themeId = default.
  app.put('/stores/:id/theme/bundle/draft', requireMembership, (c) =>
    draftPut(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );
  app.get('/stores/:id/theme/bundle/draft', requireMembership, (c) =>
    draftGet(c, mainThemeId(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/scaffold', requireMembership, (c) =>
    scaffold(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/preview', requireMembership, (c) =>
    preview(c, mainThemeId(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/publish', requireRole('owner'), (c) =>
    publishBundle(c, mainThemeId(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/rollback', requireRole('owner'), (c) => rollbackBundle(c));
  app.post('/stores/:id/theme/bundle/reset', requireMembership, (c) =>
    resetBundle(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );

  // Theme-scoped editing mounts (multi-theme). assertThemeInStore enforces ownership on each.
  app.put('/stores/:id/themes/:themeId/draft', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return draftPut(c, c.req.param('themeId'));
  });
  app.get('/stores/:id/themes/:themeId/draft', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return draftGet(c, c.req.param('themeId'));
  });
  app.post('/stores/:id/themes/:themeId/scaffold', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return scaffold(c, c.req.param('themeId'), async () => {});
  });
  app.post('/stores/:id/themes/:themeId/preview', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return preview(c, c.req.param('themeId'));
  });
  app.post('/stores/:id/themes/:themeId/reset', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return resetBundle(c, c.req.param('themeId'));
  });
  app.post('/stores/:id/themes/:themeId/publish', requireRole('owner'), async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return publishBundle(c, c.req.param('themeId'));
  });
  // Theme-scoped rollback = repoint the live pointer to (this theme, an earlier version). Unlike the
  // legacy /theme/bundle/rollback (which rolls whatever is live), this is themeId-aware: rolling a
  // theme back to vN makes THAT theme live at vN. Same primitive as activate.
  app.post('/stores/:id/themes/:themeId/rollback', requireRole('owner'), async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') return c.json({ error: 'version required' }, 400);
    const bad = await assertVersionOwnsDocument(themes, c, id, themeId, body.version);
    if (bad) return bad;
    try {
      await themes.setLive(id, themeId, body.version);
    } catch (e) {
      if (e instanceof Error && /unknown version|no published version/.test(e.message))
        return c.json({ error: e.message }, 404);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ ok: true, version: body.version });
  });
}
