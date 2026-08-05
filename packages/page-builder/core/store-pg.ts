// Postgres implementation of the page-builder PageStore (Slice 1). One row per (tenant, path)
// with draft_doc / live_doc JSONB and a monotonic revision; a page_purge_outbox for durable
// purge intents. publish() promotes + enqueues in a single transaction.
import type { PageDoc } from './doc';
import type { PageStore, PageMeta } from './store';
import { pool } from '@ratio/shared/db';

export class PgPageStore implements PageStore {
  async saveDraft(tenantId: string, doc: PageDoc): Promise<void> {
    await pool.query(
      `INSERT INTO pages (tenant_id, path, draft_doc)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, path)
       DO UPDATE SET draft_doc = EXCLUDED.draft_doc, updated_at = now()`,
      [tenantId, doc.path, JSON.stringify(doc)]
    );
  }

  async getDraft(tenantId: string, path: string): Promise<PageDoc | null> {
    const { rows } = await pool.query<{ draft_doc: PageDoc | null }>(
      'SELECT draft_doc FROM pages WHERE tenant_id = $1 AND path = $2',
      [tenantId, path]
    );
    return rows[0]?.draft_doc ?? null;
  }

  async getLive(tenantId: string, path: string): Promise<PageDoc | null> {
    const { rows } = await pool.query<{ live_doc: PageDoc | null }>(
      'SELECT live_doc FROM pages WHERE tenant_id = $1 AND path = $2',
      [tenantId, path]
    );
    return rows[0]?.live_doc ?? null;
  }

  async listPages(tenantId: string): Promise<PageMeta[]> {
    const { rows } = await pool.query<{
      path: string;
      revision: string;
      published: boolean;
      has_draft: boolean;
    }>(
      `SELECT path, revision,
              (live_doc IS NOT NULL)  AS published,
              (draft_doc IS NOT NULL) AS has_draft
         FROM pages WHERE tenant_id = $1 ORDER BY path`,
      [tenantId]
    );
    return rows.map((r) => ({
      path: r.path,
      revision: Number(r.revision),
      published: r.published,
      hasDraft: r.has_draft,
    }));
  }

  async revision(tenantId: string, path: string): Promise<number> {
    const { rows } = await pool.query<{ revision: string }>(
      'SELECT revision FROM pages WHERE tenant_id = $1 AND path = $2',
      [tenantId, path]
    );
    return rows[0] ? Number(rows[0].revision) : 0;
  }

  async publish(
    tenantId: string,
    path: string,
    tags: string[]
  ): Promise<{ revision: number; outboxId: number } | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query<{ revision: string }>(
        `UPDATE pages SET live_doc = draft_doc, revision = revision + 1, updated_at = now()
         WHERE tenant_id = $1 AND path = $2 AND draft_doc IS NOT NULL
         RETURNING revision`,
        [tenantId, path]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return null; // no draft to publish
      }
      const ins = await client.query<{ id: string }>(
        'INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2) RETURNING id',
        [tenantId, tags]
      );
      await client.query('COMMIT');
      return { revision: Number(upd.rows[0].revision), outboxId: Number(ins.rows[0].id) };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async enqueuePurge(tenantId: string, tags: string[]): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2) RETURNING id',
      [tenantId, tags]
    );
    return Number(rows[0].id);
  }

  async markPurgeDone(id: number): Promise<void> {
    await pool.query("UPDATE page_purge_outbox SET state = 'done' WHERE id = $1", [id]);
  }

  async pendingPurges(tenantId: string): Promise<{ id: number; tags: string[] }[]> {
    const { rows } = await pool.query<{ id: string; tags: string[] }>(
      "SELECT id, tags FROM page_purge_outbox WHERE tenant_id = $1 AND state = 'pending' ORDER BY id",
      [tenantId]
    );
    return rows.map((r) => ({ id: Number(r.id), tags: r.tags }));
  }
}
