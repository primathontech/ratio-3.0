// Theme versioning (ADR-013 §13). The theme is the ATOMIC unit of publish/rollback, on the
// immutable-snapshot + movable-pointer model — the same primitive as the edge cache (publish/
// rollback = pointer move + tag-purge).
//
//   - publishTheme: promote every page's draft → live, snapshot the whole store's live state +
//     tokens into an IMMUTABLE theme_versions row, and move tenants.published_theme_version to it.
//   - rollbackTheme: repoint to an earlier version and restore live state from its snapshot
//     (drafts are untouched — you can always publish forward again).
//   - Optimistic concurrency: publishTheme takes the version the caller last saw; a mismatch is a
//     ThemeConflict (→ HTTP 409), so two editors / editor-vs-AI can't clobber each other.
//
// Per-page editing (pages.draft_doc) is unchanged; this adds the theme layer on top. All published
// versions are kept (a manifest is KB-scale JSON).
import type { PageDoc } from './doc';
import type { ThemeTokens } from './storefront';
import { pool } from '@ratio/data-db';
import { tenantTag } from './tags';

export interface ThemeManifest {
  tokens: ThemeTokens;
  pages: Record<string, PageDoc>; // path → the live PageDoc at snapshot time
}

export interface ThemeVersionMeta {
  version: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

// Raised when publishTheme's expected base version doesn't match the current pointer (concurrent
// edit). Callers map it to HTTP 409.
export class ThemeConflict extends Error {
  constructor(
    public expected: number | null,
    public actual: number | null
  ) {
    super(`theme was published concurrently (expected v${expected ?? 0}, now v${actual ?? 0})`);
    this.name = 'ThemeConflict';
  }
}

export class PgThemeStore {
  // The currently-published version pointer (null = never published).
  async publishedVersion(tenantId: string): Promise<number | null> {
    const { rows } = await pool.query<{ v: string | null }>(
      'SELECT published_theme_version AS v FROM tenants WHERE id = $1',
      [tenantId]
    );
    const v = rows[0]?.v;
    return v == null ? null : Number(v);
  }

  // Publish the whole theme atomically: promote all drafts → live, snapshot, move the pointer.
  // `expectedBase` (optional) enables optimistic concurrency — pass the version the editor loaded.
  async publishTheme(
    tenantId: string,
    opts: { by?: string; note?: string; expectedBase?: number | null } = {}
  ): Promise<{ version: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the tenant row so concurrent publishes serialize on the version bump.
      const cur = await client.query<{ v: string | null; theme: ThemeTokens }>(
        'SELECT published_theme_version AS v, theme FROM tenants WHERE id = $1 FOR UPDATE',
        [tenantId]
      );
      if (cur.rowCount === 0) throw new Error(`unknown tenant '${tenantId}'`);
      const current = cur.rows[0].v == null ? null : Number(cur.rows[0].v);

      if (opts.expectedBase !== undefined && (opts.expectedBase ?? null) !== current) {
        throw new ThemeConflict(opts.expectedBase ?? null, current);
      }

      // Promote every page that has a draft → live (revision bumped only where a draft existed).
      await client.query(
        `UPDATE pages SET live_doc = draft_doc, revision = revision + 1, updated_at = now()
         WHERE tenant_id = $1 AND draft_doc IS NOT NULL`,
        [tenantId]
      );

      // Snapshot the whole store's live state into a manifest.
      const live = await client.query<{ path: string; live_doc: PageDoc }>(
        'SELECT path, live_doc FROM pages WHERE tenant_id = $1 AND live_doc IS NOT NULL',
        [tenantId]
      );
      const pages: Record<string, PageDoc> = {};
      for (const r of live.rows) pages[r.path] = r.live_doc;
      const manifest: ThemeManifest = { tokens: cur.rows[0].theme ?? {}, pages };

      const version = (current ?? 0) + 1;
      await client.query(
        `INSERT INTO theme_versions (tenant_id, version, manifest, note, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [tenantId, version, JSON.stringify(manifest), opts.note ?? null, opts.by ?? null]
      );
      await client.query('UPDATE tenants SET published_theme_version = $2 WHERE id = $1', [
        tenantId,
        version,
      ]);
      // Refresh the edge: the whole tenant's pages changed together.
      await client.query('INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2)', [
        tenantId,
        [tenantTag(tenantId)],
      ]);

      await client.query('COMMIT');
      return { version };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Roll back to an earlier version: restore live state + tokens from its snapshot and repoint.
  // Non-destructive — drafts are untouched, and every version stays in history (roll forward again).
  async rollbackTheme(tenantId: string, version: number): Promise<{ version: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const snap = await client.query<{ manifest: ThemeManifest }>(
        'SELECT manifest FROM theme_versions WHERE tenant_id = $1 AND version = $2',
        [tenantId, version]
      );
      if (snap.rowCount === 0) throw new Error(`theme version v${version} not found`);
      const manifest = snap.rows[0].manifest;
      const paths = Object.keys(manifest.pages);

      // Restore live_doc for the snapshot's pages; UN-publish any page not in the snapshot (its
      // live_doc → NULL, so the store's live surface matches the version exactly). Drafts untouched.
      for (const path of paths) {
        await client.query(
          `INSERT INTO pages (tenant_id, path, live_doc, revision)
           VALUES ($1, $2, $3::jsonb, 1)
           ON CONFLICT (tenant_id, path)
           DO UPDATE SET live_doc = EXCLUDED.live_doc, revision = pages.revision + 1, updated_at = now()`,
          [tenantId, path, JSON.stringify(manifest.pages[path])]
        );
      }
      await client.query(
        `UPDATE pages SET live_doc = NULL, updated_at = now()
         WHERE tenant_id = $1 AND live_doc IS NOT NULL AND NOT (path = ANY($2))`,
        [tenantId, paths]
      );

      await client.query(
        'UPDATE tenants SET theme = $2::jsonb, published_theme_version = $3 WHERE id = $1',
        [tenantId, JSON.stringify(manifest.tokens ?? {}), version]
      );
      await client.query('INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2)', [
        tenantId,
        [tenantTag(tenantId)],
      ]);

      await client.query('COMMIT');
      return { version };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Version history, newest first.
  async listVersions(tenantId: string): Promise<ThemeVersionMeta[]> {
    const { rows } = await pool.query<{
      version: string;
      note: string | null;
      created_by: string | null;
      created_at: string;
    }>(
      `SELECT version, note, created_by, created_at
         FROM theme_versions WHERE tenant_id = $1 ORDER BY version DESC`,
      [tenantId]
    );
    return rows.map((r) => ({
      version: Number(r.version),
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  // A specific version's snapshot — for preview / diff.
  async getVersion(tenantId: string, version: number): Promise<ThemeManifest | null> {
    const { rows } = await pool.query<{ manifest: ThemeManifest }>(
      'SELECT manifest FROM theme_versions WHERE tenant_id = $1 AND version = $2',
      [tenantId, version]
    );
    return rows[0]?.manifest ?? null;
  }
}
