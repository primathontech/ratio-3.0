import type { Context, Hono, MiddlewareHandler } from 'hono';
import {
  DraftConflict,
  ensureSeededBaseById,
  baseThemeDef,
  layoutOwnsDocument,
  validateThemeFiles,
  LIBRARY_TENANT_ID,
  DEFAULT_BASE_THEME_ID,
  type ThemeFiles,
} from '@ratio/builder-core';
import { pool } from '@ratio/data-db';
import { isPlatformAdmin, denyNarrowedScope } from '../../middleware/auth';
import type { RouteDeps, Vars } from '../deps';

// Platform-admin editor over a shared BASE theme (owned by `_library`) — OFCE-656. A base is the theme
// stores derive from; improving it here + publishing a new base version is what the propagation console
// (base.ts) then rolls out to stores on THAT base. Which base is edited comes from `?base=<id>`,
// defaulting to the platform Default (`library-default`); an unknown id is a 400. It reuses the store
// editor's draft/preview/publish machinery pointed at the base, with two differences from a store theme:
// publish is always makeLive:false (a base is never anyone's live theme), and base authoring is the
// source of truth (seed-only, so an edit here is never clobbered by a later deploy).
//
// Gated exactly like the propagation routes: denyNarrowedScope + isPlatformAdmin. `_library` has no
// memberships, so a normal user can't reach it; a platform admin bypasses the membership guard.
type BaseRef = { themeId: string; tenantId: string };

// The base being edited: `?base=<id>` (defaults to the platform Default). Returns null for an unknown id
// so the caller 400s rather than editing a phantom theme.
function resolveBaseRef(c: Context<Vars>): BaseRef | null {
  const id = c.req.query('base') || DEFAULT_BASE_THEME_ID;
  return baseThemeDef(id) ? { themeId: id, tenantId: LIBRARY_TENANT_ID } : null;
}

// The latest published source of a base (the whole tree — a base is a root theme), or null if it has no
// published version yet. Used to (re)load the draft from what's actually published.
async function latestPublishedBaseSource(
  themes: NonNullable<RouteDeps['themes']>,
  themeId: string
): Promise<ThemeFiles | null> {
  const { rows } = await pool.query<{ source_hash: string }>(
    'SELECT source_hash FROM theme_bundle_version WHERE theme_id = $1 ORDER BY version DESC LIMIT 1',
    [themeId]
  );
  const hash = rows[0]?.source_hash;
  return hash ? await themes.loadSource(LIBRARY_TENANT_ID, themeId, hash) : null;
}

const realFileCount = (t: ThemeFiles) => Object.keys(t).filter((k) => k !== '_deletes').length;

export function registerBaseThemeEditRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { themes, identityCompile, bundle503, renderThemePreview } = deps;

  const platformAdminOnly: MiddlewareHandler<Vars> = async (c, next) => {
    if (!isPlatformAdmin(c.get('userId'))) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
  const unknownBase = (c: Context<Vars>) => c.json({ error: 'unknown base theme' }, 400);

  // The base's composed tree (a root theme, so the draft IS the whole theme) + the revision token the
  // editor round-trips. Seeds the base from the code default on a fresh env so it opens populated.
  app.get('/admin/base-theme/edit/draft', denyNarrowedScope, platformAdminOnly, async (c) => {
    if (!themes) return bundle503(c);
    const ref = resolveBaseRef(c);
    if (!ref) return unknownBase(c);
    await ensureSeededBaseById(themes, ref.themeId, { compile: identityCompile });
    // Recover a missing draft (DR / bucket migration / a store diverged from code so seed-only's
    // code-matches self-heal doesn't apply): if the draft came back empty but a version IS published,
    // reload the draft from that published source so the editor never opens on a blank base.
    if (realFileCount(await themes.readDraft(ref)) === 0) {
      const published = await latestPublishedBaseSource(themes, ref.themeId);
      if (published && realFileCount(published) > 0) await themes.saveDraft(ref, published);
    }
    const [files, revision] = await Promise.all([
      themes.readComposed(ref),
      themes.draftRevision(ref),
    ]);
    return c.json({ files, revision });
  });

  // Save the base draft. Same reject-on-save validation as a store theme; 409 on a concurrent edit.
  app.put('/admin/base-theme/edit/draft', denyNarrowedScope, platformAdminOnly, async (c) => {
    if (!themes) return bundle503(c);
    const ref = resolveBaseRef(c);
    if (!ref) return unknownBase(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      files?: ThemeFiles;
      revision?: string;
    };
    if (typeof body.revision !== 'string')
      return c.json({ error: 'revision is required to save a draft' }, 400);
    const issues = validateThemeFiles(body.files ?? {});
    if (issues.length) return c.json({ error: 'theme has validation errors', issues }, 400);
    try {
      const { hash } = await themes.saveOverrides(ref, body.files ?? {}, {
        expectedRevision: body.revision,
      });
      c.set('auditTenant', LIBRARY_TENANT_ID);
      return c.json({ ok: true, hash });
    } catch (e) {
      if (e instanceof DraftConflict)
        return c.json({ error: 'conflict', currentRevision: e.actual }, 409);
      throw e;
    }
  });

  // Live preview of a base page. No store commerce context — renders with sample data.
  app.post('/admin/base-theme/edit/preview', denyNarrowedScope, platformAdminOnly, async (c) => {
    if (!themes) return bundle503(c);
    const ref = resolveBaseRef(c);
    if (!ref) return unknownBase(c);
    const body = (await c.req.json().catch(() => ({}))) as { files?: ThemeFiles; page?: string };
    const files = body.files ?? (await themes.readComposed(ref));
    try {
      const { html, sampleData } = await renderThemePreview(
        files,
        body.page || 'index',
        LIBRARY_TENANT_ID,
        undefined,
        undefined,
        'Base theme'
      );
      return c.json({ html, sampleData });
    } catch (e) {
      // A Liquid/template error is the editor's own code → { error } (200), not a 500.
      console.error('[admin-api] base theme preview failed:', e);
      return c.json({ error: e instanceof Error ? e.message : 'preview failed' });
    }
  });

  // Publish a new immutable base version (makeLive:false — the base is never a live theme). Stores on an
  // older base version are now behind; the propagation console pulls it into them. Enforces the full-
  // document invariant (untrusted admin/AI layout) — the base is what every store's whole page derives
  // from, so a body-only base layout would break every derived store.
  app.post('/admin/base-theme/edit/publish', denyNarrowedScope, platformAdminOnly, async (c) => {
    if (!themes) return bundle503(c);
    const ref = resolveBaseRef(c);
    if (!ref) return unknownBase(c);
    const composed = await themes.readComposed(ref);
    if (Object.keys(composed).length > 0 && !layoutOwnsDocument(composed['layout/theme.liquid']))
      return c.json(
        {
          error:
            'layout/theme.liquid must be a full HTML document (start with <!doctype or <html) before publishing',
        },
        400
      );
    let version: number;
    try {
      ({ version } = await themes.publish(ref, {
        compile: identityCompile,
        makeLive: false,
        by: c.get('userId'),
      }));
    } catch (e) {
      if (e instanceof Error && /unknown theme/.test(e.message))
        return c.json({ error: 'no base draft to publish — edit the base first' }, 400);
      throw e; // infra faults bubble to onError → 500
    }
    c.set('auditTenant', LIBRARY_TENANT_ID);
    return c.json({ ok: true, version });
  });

  // Discard unpublished base edits — restore the draft to the latest published base version's source.
  // NOTE: NOT resetDraft() — that stores empty overrides ("pure base"), which for a store theme means
  // "the base", but the base itself is a ROOT theme (no base of its own), so empty overrides would blank
  // it. Instead reload the last published source and store it as the draft.
  app.post(
    '/admin/base-theme/edit/reset',
    denyNarrowedScope,
    platformAdminOnly,
    async (c: Context<Vars>) => {
      if (!themes) return bundle503(c);
      const ref = resolveBaseRef(c);
      if (!ref) return unknownBase(c);
      const source = await latestPublishedBaseSource(themes, ref.themeId);
      await themes.saveDraft(ref, source ?? {});
      const [files, revision] = await Promise.all([
        themes.readComposed(ref),
        themes.draftRevision(ref),
      ]);
      c.set('auditTenant', LIBRARY_TENANT_ID);
      return c.json({ ok: true, files, revision });
    }
  );
}
