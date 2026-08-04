// Page-builder write side (Slice 1) — draft/publish orchestration (D4) over a durable purge
// outbox (D2). saveDraft never touches the live page or the edge cache; publish is the ONLY
// action that promotes draft -> live and purges the tag.
//
// Why an outbox: under a long shell TTL a lost purge = stale content effectively forever. The
// purge intent is enqueued in the SAME transaction as the promote (see PgPageStore.publish), so
// neither a failed purge API call nor a crash-after-commit can strand a stale page — drainPurges()
// retries anything left pending. invalidate is idempotent, so retries are safe.

import type { PageDoc } from './doc';
import { validatePageDoc } from './doc';
import { canonicalPath } from './path';
import type { SectionRegistry } from '@ratio/page-builder-registry/registry';
import { pageTag, tenantTag } from './tags';

// The edge purge seam (D2): CF tag-purge now, Akamai Fast Purge later — same interface.
export interface PurgeLike {
  invalidateByTags(tags: string[]): Promise<void>;
}

// Persistence seam. Draft/live per D4. `revision` is the live generation — bumped on publish,
// monotonic, never regresses.
export interface PageStore {
  saveDraft(tenantId: string, doc: PageDoc): Promise<void>;
  getDraft(tenantId: string, path: string): Promise<PageDoc | null>;
  getLive(tenantId: string, path: string): Promise<PageDoc | null>;
  revision(tenantId: string, path: string): Promise<number>;
  // Atomically promote the draft to live, bump revision, and enqueue the purge intent — ONE
  // transaction. Returns null if there is no draft to publish.
  publish(
    tenantId: string,
    path: string,
    tags: string[]
  ): Promise<{ revision: number; outboxId: number } | null>;
  enqueuePurge(tenantId: string, tags: string[]): Promise<number>;
  markPurgeDone(id: number): Promise<void>;
  pendingPurges(tenantId: string): Promise<{ id: number; tags: string[] }[]>;
}

export class PurgeFailed extends Error {
  constructor(cause: unknown) {
    super(
      `content PUBLISHED and purge intent RECORDED, but the purge call FAILED — cached pages ` +
        `stay stale until drainPurges() succeeds: ${String(cause)}`
    );
    this.name = 'PurgeFailed';
  }
}

export class PageBuilder {
  constructor(
    private store: PageStore,
    private registry: SectionRegistry,
    private purge: PurgeLike
  ) {}

  // Save a draft: validate + pin versions, write the draft. No purge, live page untouched.
  async saveDraft(tenantId: string, doc: PageDoc): Promise<PageDoc> {
    const pinned = validatePageDoc(doc, this.registry);
    await this.store.saveDraft(tenantId, pinned);
    return pinned;
  }

  // Publish: promote the draft live and purge its tag. Promote + purge-intent are atomic in the
  // store; the purge CALL is best-effort-with-retry — a failure is loud (PurgeFailed) and leaves
  // the intent pending for drainPurges(). Returns null if there was no draft to publish.
  async publish(tenantId: string, path: string): Promise<{ revision: number } | null> {
    const canon = canonicalPath(path);
    const tags = [pageTag(tenantId, canon)];
    const res = await this.store.publish(tenantId, canon, tags);
    if (!res) return null;
    try {
      await this.purge.invalidateByTags(tags);
    } catch (e) {
      throw new PurgeFailed(e);
    }
    await this.store.markPurgeDone(res.outboxId);
    return { revision: res.revision };
  }

  // Theme-wide change: ONE tenant-tag purge, not O(pages) calls.
  async themeChanged(tenantId: string): Promise<void> {
    const tags = [tenantTag(tenantId)];
    const id = await this.store.enqueuePurge(tenantId, tags);
    try {
      await this.purge.invalidateByTags(tags);
    } catch (e) {
      throw new PurgeFailed(e);
    }
    await this.store.markPurgeDone(id);
  }

  // Retry every pending purge (cron / editor error-banner). Stops on the first failure, leaving
  // the remainder pending. Returns how many drained.
  async drainPurges(tenantId: string): Promise<number> {
    const pending = await this.store.pendingPurges(tenantId);
    let drained = 0;
    for (const entry of pending) {
      await this.purge.invalidateByTags(entry.tags);
      await this.store.markPurgeDone(entry.id);
      drained++;
    }
    return drained;
  }
}
