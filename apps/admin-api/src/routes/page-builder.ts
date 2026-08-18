import type { Hono } from 'hono';
import type { PageDoc } from '@ratio/builder-core';
import { requireMembership } from '../middleware/auth';
import type { RouteDeps, Vars } from './deps';

export function registerPageBuilderRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { sectionCatalog, pbStore, pageBuilder, purgeStoreUrls } = deps;

  // --- Page builder (ADR-013 / D4 draft->publish). The editor's write surface: save a draft
  // (validated + version-pinned, live page untouched), then publish to promote draft->live and
  // purge. The origin serves the published PageDoc (the sole renderer). ---

  // Global section catalog (any authenticated user) — the editor renders inputs from it.
  app.get('/page-builder/catalog', (c) => c.json({ sections: sectionCatalog() }));

  // Every page-builder page for a store (path + publish state) — the editor's page switcher.
  app.get('/stores/:id/page-builder/pages', requireMembership, async (c) => {
    return c.json({ pages: await pbStore.listPages(c.req.param('id')) });
  });

  app.get('/stores/:id/page-builder', requireMembership, async (c) => {
    const id = c.req.param('id')!;
    const path = c.req.query('path') || '/';
    const [draft, live, revision] = await Promise.all([
      pbStore.getDraft(id, path),
      pbStore.getLive(id, path),
      pbStore.revision(id, path),
    ]);
    return c.json({ path, draft, live, revision, hasDraft: draft !== null });
  });

  app.put('/stores/:id/page-builder', requireMembership, async (c) => {
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { doc?: unknown };
    if (typeof body.doc !== 'object' || body.doc === null) {
      return c.json({ error: 'doc (a PageDoc) is required' }, 400);
    }
    try {
      // validatePageDoc (inside saveDraft) rejects unknown section/block types + bad settings.
      const draft = await pageBuilder.saveDraft(id, body.doc as PageDoc);
      c.set('auditTenant', id);
      return c.json({ ok: true, draft });
    } catch (e) {
      return c.json({ error: 'invalid page doc', detail: (e as Error).message }, 422);
    }
  });

  app.post('/stores/:id/page-builder/publish', requireMembership, async (c) => {
    const id = c.req.param('id')!;
    const path = ((await c.req.json().catch(() => ({}))) as { path?: string }).path || '/';
    const res = await pageBuilder.publish(id, path);
    if (!res) return c.json({ error: 'no draft to publish' }, 404);
    // pageBuilder.publish already purged the local edge by tag; also purge the prod CF edge by URL.
    const edgePurged = await purgeStoreUrls(id, [path]);
    c.set('auditTenant', id);
    return c.json({ ok: true, revision: res.revision, ...(edgePurged !== null && { edgePurged }) });
  });
}
