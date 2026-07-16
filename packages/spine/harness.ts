// Shared test harness: builds a world (DB + KV + R2 + N per-PoP caches + origin) and a helper to
// publish a release and drive edge requests. Used by the P-matrix + E0 + D28 suites.

import { FakeKV, FakeR2, FakeCache, Fault, type StoredResponse } from './stores';
import { FakeReleaseDB } from './fake-db';
import { Publisher, type RouteInput } from './publisher';
import { handle, type ReadOrder, type OriginLike, type EdgeResult } from './edge';
import { canonicalPath } from './canonical-key';

export interface Route {
  path: string;
  status?: number; // default 200
  location?: string; // for redirects
  body?: string;
}

export class World {
  clockMs = 1_000_000;
  db = new FakeReleaseDB();
  kv = new FakeKV(new Fault());
  r2 = new FakeR2(new Fault());
  origin: OriginLike & { fault: Fault; content: Map<string, StoredResponse> };
  caches = new Map<string, FakeCache>(); // colo -> cache
  hosts: string[];
  tenantId: string;

  constructor(tenantId = 't_acme', hosts = ['acme.localhost']) {
    this.tenantId = tenantId;
    this.hosts = hosts;
    const fault = new Fault();
    const content = new Map<string, StoredResponse>();
    const origin = {
      renders: 0,
      fault,
      content,
      async fetch(_t: string, release: number, path: string) {
        if (fault.down) throw new Error('origin down');
        origin.renders++;
        const c = content.get(release + '|' + path);
        if (!c) return { status: 404, headers: {}, body: 'not found' };
        return { status: c.status, headers: c.headers, body: c.body };
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
        const headers: Record<string, string> = { 'content-type': 'text/html' };
        if (r.location) headers.location = r.location;
        return { status: r.status ?? 200, headers, body: r.body ?? `<html>${r.path}</html>` };
      },
    }));
  }

  // publish a release; also seed origin content for that release so origin-first can render
  async publish(
    routes: Route[],
    opts?: { crashAt?: ConstructorParameters<typeof Publisher>[3]; themeVersion?: string }
  ) {
    const inputs = this.routeInputs(routes);
    const pub = new Publisher(this.db, this.kv, this.r2, opts?.crashAt);
    // pre-seed origin so origin-first tests can render live (before we ever kill origin)
    // NOTE: we must know the releaseId; commit first, then seed, then continue phases.
    const releaseId = await pub.commit(this.tenantId, inputs, opts?.themeVersion ?? 'theme-v1');
    for (const r of inputs) {
      const rr = r.render();
      const p = canonicalPath(new URL('https://x' + r.path).pathname);
      this.origin.content.set(`${releaseId}|${p}`, {
        status: rr.status,
        headers: rr.headers,
        body: rr.body,
        checksum: 'origin',
      });
    }
    await pub.materialize(releaseId, inputs);
    await pub.activate(releaseId, this.hosts);
    return releaseId;
  }

  req(
    path: string,
    order: ReadOrder,
    colo = 'BOM',
    extra?: { method?: string; host?: string }
  ): Promise<EdgeResult> {
    return handle(
      {
        method: extra?.method ?? 'GET',
        url: 'https://x' + path,
        host: extra?.host ?? this.hosts[0],
      },
      {
        kv: this.kv,
        r2: this.r2,
        cache: this.cache(colo),
        origin: this.origin,
        order,
        colo,
        onDbQuery: () => this.db.queries++,
      }
    );
  }
}
