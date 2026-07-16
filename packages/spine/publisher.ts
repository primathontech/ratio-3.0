// Two-phase publisher (D28). The release state machine that P1–P3 exercise under crashes.
//
//   commit()      : DB txn — content + release row(status=building) + outbox row, atomic.
//   materialize() : render EVERY routable response into R2 (incl. 404/redirect tombstones) +
//                   a route index; verify count+checksums; mark release 'materialized'.
//   activate()    : write KV host keys {status:active, current:N, previous:N-1}; mark 'active'.
//
// Every phase is idempotent and crash-safe: re-running after a crash converges, and KV is only
// written once the R2 set is proven complete, so KV can never name an incomplete release.

import type { KVLike, R2Like } from './stores';
import { keyDims, r2Key } from './canonical-key';
import { checksum, toStored } from './response';

export { checksum, toStored, sanitizeHeaders } from './response';

export interface RouteInput {
  path: string;
  render: () => { status: number; headers: Record<string, string>; body: string };
}
export interface Manifest {
  releaseId: number;
  tenantId: string;
  routes: string[]; // canonical paths in the release (the enumerable routable set)
  deletedPaths: string[]; // paths present in the prior release, gone now → 404 tombstones (B-3)
  themeVersion: string;
}
// The DB seam. Real impl = Postgres; tests pass an in-memory fake to drive crash points.
export interface ReleaseDB {
  commit(tenantId: string, routes: RouteInput[], themeVersion: string): Promise<number>; // returns releaseId, writes outbox
  getManifest(releaseId: number): Promise<Manifest | null>;
  setStatus(releaseId: number, status: string): Promise<void>;
  getStatus(releaseId: number): Promise<string | null>;
  setIndexChecksum(releaseId: number, hex: string): Promise<void>; // trusted index digest (#6)
  getIndexChecksum(releaseId: number): Promise<string | null>;
  drainOutbox(tenantId: string): Promise<number[]>; // pending release ids, in order
  markOutboxDone(releaseId: number): Promise<void>;
  currentActive(tenantId: string): Promise<number | null>;
}

const ROUTE_INDEX = (tenantId: string, releaseId: number) => `idx/${tenantId}/${releaseId}`;

export class Publisher {
  constructor(
    private db: ReleaseDB,
    private kv: KVLike,
    private r2: R2Like,
    // crashAt lets tests kill the process at a named phase boundary (P1)
    private crashAt?: 'after-commit' | 'mid-materialize' | 'after-verify' | 'mid-hostkeys'
  ) {}

  // Phase 1 — atomic content+release+outbox commit.
  async commit(tenantId: string, routes: RouteInput[], themeVersion: string): Promise<number> {
    const releaseId = await this.db.commit(tenantId, routes, themeVersion);
    if (this.crashAt === 'after-commit') throw new CrashSignal('after-commit');
    return releaseId;
  }

  // Phases 2+3 — materialize every response into R2, write route index, verify, mark materialized.
  async materialize(releaseId: number, routes: RouteInput[]): Promise<void> {
    const manifest = await this.db.getManifest(releaseId);
    if (!manifest) throw new Error('no manifest for release ' + releaseId);

    const index: Record<string, { key: string; checksum: string; status: number }> = {};
    let i = 0;
    for (const route of routes) {
      const url = new URL('https://x' + route.path);
      const dims = keyDims(manifest.tenantId, releaseId, url);
      const stored = toStored(route.render());
      await this.r2.put(r2Key(dims), stored);
      index[dims.path] = { key: r2Key(dims), checksum: stored.checksum, status: stored.status };
      if (this.crashAt === 'mid-materialize' && ++i === Math.ceil(routes.length / 2))
        throw new CrashSignal('mid-materialize');
    }
    // B-3: materialize a 404 TOMBSTONE for every route deleted since the prior release, so a
    // now-deleted page can never resurrect from anywhere and returns a correct 404 even in outage.
    for (const path of manifest.deletedPaths) {
      const dims = keyDims(manifest.tenantId, releaseId, new URL('https://x' + path));
      const tomb = toStored({
        status: 404,
        headers: { 'content-type': 'text/html' },
        body: 'Not found',
      });
      await this.r2.put(r2Key(dims), tomb);
      index[dims.path] = { key: r2Key(dims), checksum: tomb.checksum, status: 404 };
    }
    // route index: unknown-path 404s during outage resolve against this (spec 02 v3.1). Its own
    // content digest is recorded in the DB (trusted) so verify can detect a corrupted index (#6).
    const indexBody = JSON.stringify(index);
    const indexStored = toStored({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: indexBody,
    });
    await this.r2.put(ROUTE_INDEX(manifest.tenantId, releaseId), indexStored);
    await this.db.setIndexChecksum(releaseId, indexStored.checksum);

    // Phase 3 — verify completeness: index digest matches DB, every route+tombstone present.
    await this.verify(releaseId, manifest);
    if (this.crashAt === 'after-verify') throw new CrashSignal('after-verify');
    await this.db.setStatus(releaseId, 'materialized');
  }

  async verify(releaseId: number, manifest: Manifest): Promise<void> {
    const idxObj = await this.r2.get(ROUTE_INDEX(manifest.tenantId, releaseId));
    if (!idxObj) throw new IncompleteRelease('route index missing');
    // (#6) the index is only trustworthy if its recomputed digest matches the value recorded in
    // the DB at materialize time — a corrupted index body is caught here, not silently accepted.
    const trusted = await this.db.getIndexChecksum(releaseId);
    const actualIdx = checksum({
      status: idxObj.status,
      headers: idxObj.headers,
      body: idxObj.body,
    });
    if (!trusted || actualIdx !== trusted)
      throw new IncompleteRelease('route index digest mismatch');
    const index = JSON.parse(idxObj.body) as Record<
      string,
      { key: string; checksum: string; status: number }
    >;
    const expected = [...manifest.routes, ...manifest.deletedPaths];
    if (Object.keys(index).length !== expected.length)
      throw new IncompleteRelease(`count ${Object.keys(index).length} != ${expected.length}`);
    for (const path of expected) {
      const entry = index[path];
      if (!entry) throw new IncompleteRelease('missing route ' + path);
      const obj = await this.r2.get(entry.key);
      if (!obj) throw new IncompleteRelease('missing object ' + entry.key);
      // Recompute from the object's actual bytes — never trust the object's self-reported field.
      const actual = checksum({ status: obj.status, headers: obj.headers, body: obj.body });
      if (actual !== entry.checksum) throw new IncompleteRelease('checksum mismatch ' + path);
    }
  }

  // Phase 4 — activate: flip KV host keys to name this release. Enforces the R2 barrier as a
  // STATE-MACHINE invariant (H-2), not call-order luck: refuses unless the release is materialized.
  async activate(releaseId: number, hosts: string[]): Promise<void> {
    const manifest = await this.db.getManifest(releaseId);
    if (!manifest) throw new Error('no manifest');
    const status = await this.db.getStatus(releaseId);
    if (status === 'active') return; // (#3) idempotent no-op — re-activating must not corrupt `previous`
    if (status !== 'materialized')
      throw new Error(
        `activation barrier: release ${releaseId} is '${status}', not 'materialized'`
      );
    const previous = await this.db.currentActive(manifest.tenantId);
    // pointer never regresses (P1): refuse to activate an older release over a newer active one
    if (previous !== null && releaseId < previous)
      throw new Error(`pointer regression: ${releaseId} < active ${previous}`);
    const rec = JSON.stringify({
      status: 'active',
      tenantId: manifest.tenantId,
      current: releaseId,
      previous,
    });
    let j = 0;
    for (const host of hosts) {
      await this.kv.put(`host:${host}`, rec);
      if (this.crashAt === 'mid-hostkeys' && ++j === Math.ceil(hosts.length / 2))
        throw new CrashSignal('mid-hostkeys');
    }
    await this.db.setStatus(releaseId, 'active');
    await this.db.markOutboxDone(releaseId);
  }

  // Full publish, resumable. A serialized per-tenant caller drives this; on crash, re-invoke:
  // each phase no-ops if already done, so retries are idempotent and converge (P1/P2).
  async publish(tenantId: string, routes: RouteInput[], themeVersion: string, hosts: string[]) {
    const releaseId = await this.commit(tenantId, routes, themeVersion);
    await this.materialize(releaseId, routes);
    await this.activate(releaseId, hosts);
    return releaseId;
  }
}

export class CrashSignal extends Error {
  constructor(public phase: string) {
    super('CRASH@' + phase);
  }
}
export class IncompleteRelease extends Error {}
