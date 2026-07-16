// Shared test harness: builds a world (DB + KV + R2 + N per-PoP caches + origin) and a helper to
// publish a release and drive edge requests. Used by the P-matrix + E0 + D28 suites.

import { FakeKV, FakeR2, FakeCache, Fault } from './stores';
import { FakeReleaseDB } from './fake-db';
import { Publisher, type RouteInput } from './publisher';
import { handle, type ReadOrder, type OriginLike, type EdgeResult } from './edge';
import { keyDims, cacheKey, type KeyDims } from './canonical-key';

export interface Route {
  path: string;
  status?: number; // default 200
  location?: string; // for redirects
  body?: string;
  cacheable?: boolean; // default true; false models a no-store/dynamic page
  extraHeaders?: Record<string, string>; // e.g. inject set-cookie/authorization to test sanitize (P10)
}

interface OriginEntry {
  status: number;
  headers: Record<string, string>;
  body: string;
  cacheable: boolean;
}

export class World {
  clockMs = 1_000_000;
  db = new FakeReleaseDB();
  kv = new FakeKV(new Fault());
  r2 = new FakeR2(new Fault());
  origin: OriginLike & { fault: Fault; content: Map<string, OriginEntry> };
  caches = new Map<string, FakeCache>(); // colo -> cache
  hosts: string[];
  tenantId: string;

  constructor(tenantId = 't_acme', hosts = ['acme.localhost']) {
    this.tenantId = tenantId;
    this.hosts = hosts;
    const fault = new Fault();
    const content = new Map<string, OriginEntry>();
    const origin = {
      renders: 0,
      fault,
      content,
      // Renders per canonical request (B-1): keyed by the full cache key, so ?sort=x and ?sort=y
      // are distinct renders — the edge caches exactly what the origin rendered for these dims.
      async fetch(dims: KeyDims) {
        if (fault.down) throw new Error('origin down');
        origin.renders++;
        const c = content.get(cacheKey(dims));
        if (!c)
          return {
            status: 404,
            headers: { 'content-type': 'text/html' },
            body: 'not found',
            cacheable: true,
          };
        return { status: c.status, headers: c.headers, body: c.body, cacheable: c.cacheable };
      },
    };
    this.origin = origin;
  }

  clock = () => this.clockMs;
  advance(seconds: number) {
    this.clockMs += seconds * 1000;
  }
  cache(colo: string): FakeCache {
    if (!this.caches.has(colo)) this.caches.set(colo, new FakeCache(this.clock));
    return this.caches.get(colo)!;
  }

  routeInputs(routes: Route[]): RouteInput[] {
    return routes.map((r) => ({
      path: r.path,
      render: () => {
        const headers: Record<string, string> = {
          'content-type': 'text/html',
          ...(r.extraHeaders ?? {}),
        };
        if (r.location) headers.location = r.location;
        return { status: r.status ?? 200, headers, body: r.body ?? `<html>${r.path}</html>` };
      },
    }));
  }

  // publish a release; also seed origin content (keyed by cache key) so origin-first can render live
  async publish(
    routes: Route[],
    opts?: { crashAt?: ConstructorParameters<typeof Publisher>[3]; themeVersion?: string }
  ) {
    const inputs = this.routeInputs(routes);
    const pub = new Publisher(this.db, this.kv, this.r2, opts?.crashAt);
    const releaseId = await pub.commit(this.tenantId, inputs, opts?.themeVersion ?? 'theme-v1');
    for (let i = 0; i < inputs.length; i++) {
      const rr = inputs[i].render();
      const dims = keyDims(this.tenantId, releaseId, new URL('https://x' + inputs[i].path));
      this.origin.content.set(cacheKey(dims), {
        status: rr.status,
        headers: rr.headers,
        body: rr.body,
        cacheable: routes[i].cacheable ?? true,
      });
    }
    await pub.materialize(releaseId, inputs);
    await pub.activate(releaseId, this.hosts);
    return releaseId;
  }

  // seed a bare origin entry for a specific query/dims variant (used by the P9 end-to-end test)
  seedOrigin(release: number, path: string, entry: OriginEntry) {
    const dims = keyDims(this.tenantId, release, new URL('https://x' + path));
    this.origin.content.set(cacheKey(dims), entry);
  }

  req(
    path: string,
    order: ReadOrder,
    colo = 'BOM',
    extra?: { method?: string; host?: string; cookie?: string }
  ): Promise<EdgeResult> {
    return handle(
      {
        method: extra?.method ?? 'GET',
        url: 'https://x' + path,
        host: extra?.host ?? this.hosts[0],
        // cookie is carried but the edge NEVER reads it (proves it can't enter the cache key) — P10
        cookie: extra?.cookie,
      },
      { kv: this.kv, r2: this.r2, cache: this.cache(colo), origin: this.origin, order, colo }
    );
  }
}
