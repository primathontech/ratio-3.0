// The origin side of lazy rendering: turn an edge request (canonical dims) into a rendered page.
// This is what the Hono origin mounts for public paths — and exactly the OriginLike shape
// lazy-edge.ts consumes, so the full pipeline (edit → save → purge → revalidate) is provable
// end-to-end in tests with zero adapters.
//
// Cacheability is the composed shell's own verdict (B-2): the origin opts IN via x-cache when the
// shell tier allows it — the edge never guesses.

import type { KeyDims } from '../spine/canonical-key';
import type { PageStore } from './builder';
import type { WidgetRegistry } from '../widget-registry/registry';
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
    private registry: WidgetRegistry
  ) {}

  async fetch(dims: KeyDims): Promise<RenderedPage> {
    this.renders++;
    const doc = await this.store.get(dims.tenantId, dims.path);
    if (!doc) {
      // a real 404 — cacheable, so the edge caches + tombstones it like any page (no route index
      // needed in the lazy world; purge clears it if the path comes back to life)
      return {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: 'Not found',
        cacheable: true,
      };
    }
    const page = await composePage(doc, this.registry);
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(page.cacheable ? { 'x-cache': 'long' } : {}),
        'x-page-tier': page.tier,
      },
      body: page.html,
      cacheable: page.cacheable,
    };
  }
}
