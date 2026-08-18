import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { pool } from '@ratio/data-db';
import { ensureDefaultBaseTheme, tenantTag } from '@ratio/builder-core';
import { requireMembership, requireRole } from '../../middleware/auth';
import type { RouteDeps, Vars } from '../deps';
import { assertVersionOwnsDocument } from './bundle';

// --- Multi-theme CRUD + selection (OFCE-615 Phase 1). A store may keep several themes; exactly one
// is live. Every theme-scoped route calls assertThemeInStore after the auth guard, so a member of
// store A can never touch store B's theme by passing its id (404, indistinguishable from missing).
export function registerMultiThemeRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { themes, assertThemeInStore, identityCompile, bundle503, purgeEdgeTags } = deps;

  // List the store's themes (which is live, each theme's latest published version).
  app.get('/stores/:id/themes', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    return c.json({ themes: await themes.listThemes(c.req.param('id')) });
  });

  // Create a theme — a fresh one adopting the shared Default base, or a duplicate of an existing theme.
  app.post('/stores/:id/themes', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; duplicateOf?: string };
    const themeId = `${id}-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const name = body.name ?? 'New theme';
    if (body.duplicateOf) {
      await assertThemeInStore(body.duplicateOf, id);
      await themes.createTheme(id, themeId, name, { duplicateOf: body.duplicateOf });
    } else {
      const base = await ensureDefaultBaseTheme(themes, { compile: identityCompile });
      await themes.createTheme(id, themeId, name, { base });
    }
    c.set('auditTenant', id);
    return c.json({ id: themeId });
  });

  // Rename a theme.
  app.patch('/stores/:id/themes/:themeId', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (typeof body.name !== 'string' || !body.name.trim())
      return c.json({ error: 'name is required' }, 400);
    await themes.renameTheme(id, themeId, body.name);
    c.set('auditTenant', id);
    return c.json({ ok: true });
  });

  // Delete a theme (owner). Refuses the live theme (409).
  app.delete('/stores/:id/themes/:themeId', requireRole('owner'), async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    try {
      await themes.deleteTheme(id, themeId);
    } catch (e) {
      if (e instanceof Error && /cannot delete the live theme/.test(e.message))
        return c.json({ error: e.message }, 409);
      throw e;
    }
    c.set('auditTenant', id);
    return c.json({ ok: true });
  });

  // Activate a theme at a given (or its latest published) version — the general switch/rollback primitive.
  app.post('/stores/:id/themes/:themeId/activate', requireRole('owner'), async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    const bad = await assertVersionOwnsDocument(themes, c, id, themeId, body.version);
    if (bad) return bad;
    let version: number;
    try {
      ({ version } = await themes.setLive(id, themeId, body.version));
    } catch (e) {
      if (e instanceof Error && /no published version/.test(e.message))
        return c.json({ error: e.message }, 400);
      if (e instanceof Error && /unknown version/.test(e.message))
        return c.json({ error: e.message }, 404);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ version });
  });

  // A theme's published version history + which one is live.
  app.get('/stores/:id/themes/:themeId/versions', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const versions = await themes.listVersions(id, themeId);
    const { rows } = await pool.query<{ live_theme_version: number }>(
      'SELECT live_theme_version FROM tenants WHERE id = $1 AND live_theme_id = $2',
      [id, themeId]
    );
    const liveVersion = rows[0]?.live_theme_version ?? null;
    return c.json({ versions, liveVersion });
  });
}
