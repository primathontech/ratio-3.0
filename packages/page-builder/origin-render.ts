// The origin side of lazy rendering: turn an edge request (canonical dims) into a rendered page.
// This is what the Hono origin mounts for public paths — and exactly the OriginLike shape
// lazy-edge.ts consumes, so the full pipeline (edit → save → purge → revalidate) is provable
// end-to-end in tests with zero adapters.
//
// D44: the ORIGIN owns the S3 last-good write-behind (Akamai EdgeWorkers has no waitUntil, so the
// edge cannot). Every successful shared-safe render queues a generation-ordered write; a real 404
// queues a tombstone at its own generation (D41) — the LastGoodStore drops out-of-order writes so
// a delayed old render can never regress or resurrect content (review blockers #3/#4).
//
// Cacheability is the composed shell's own verdict (B-2): the origin opts IN via x-cache when the
// shell tier allows it — the edge never guesses. Cache tags are stamped HERE (Edge-Cache-Tag) so
// the Akamai property caches with the right purge handles; the worker only forwards.

import type { KeyDims } from '../spine/canonical-key';
import { r2Key } from '../spine/canonical-key';
import { toStored } from '../spine/response';
import type { PageStore } from './builder';
import type { WidgetRegistry } from '../widget-registry/registry';
import type { LastGoodStore } from '../edge-port/last-good';
import { tenantTag, pageTag } from '../edge-port/tags';
import { composePage } from './compose';

export interface RenderedPage {
  status: number;
  headers: Record<string, string>;
  body: string;
  cacheable: boolean;
}

export class PageOrigin {
  renders = 0;
  constructor(
    private store: PageStore,
    private registry: WidgetRegistry,
    private lastGood?: LastGoodStore // absent in unit contexts; the deploy path wires it
  ) {}

  async fetch(dims: KeyDims): Promise<RenderedPage> {
    this.renders++;
    const doc = await this.store.get(dims.tenantId, dims.path);
    const tags = `${tenantTag(dims.tenantId)},${pageTag(dims.tenantId, dims.path)}`;

    if (!doc) {
      // a real 404 — cacheable, so the edge caches + purge clears it if the path comes back.
      // Tombstone last-good at THIS revision (the delete bumped it): an outage later must serve
      // this 404, never resurrect the pre-delete page from S3 (D41).
      const res: RenderedPage = {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8', 'edge-cache-tag': tags },
        body: 'Not found',
        cacheable: true,
      };
      await this.writeBehind(dims, res);
      return res;
    }

    const page = await composePage(doc, this.registry);
    const res: RenderedPage = {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(page.cacheable ? { 'x-cache': 'long', 'edge-cache-tag': tags } : {}),
        'x-page-tier': page.tier,
      },
      body: page.html,
      cacheable: page.cacheable,
    };
    // only shared-safe bytes may reach the backstop — a non-cacheable shell never enters S3
    if (page.cacheable) await this.writeBehind(dims, res);
    return res;
  }

  // Queue the last-good write at the page's current DB revision. writeIfNewer never throws and
  // drops stale generations; `await` here only ENQUEUES onto the per-key chain (the store method
  // itself does not block on S3), so the render path stays fast and deterministic for tests.
  private async writeBehind(dims: KeyDims, res: RenderedPage): Promise<void> {
    if (!this.lastGood) return;
    const generation = await this.store.revision(dims.tenantId, dims.path);
    void this.lastGood.writeIfNewer(r2Key(dims), toStored(res), generation);
  }

  // Drain in-flight last-good writes (tests, graceful shutdown).
  settle(): Promise<void> {
    return this.lastGood?.settle() ?? Promise.resolve();
  }
}
