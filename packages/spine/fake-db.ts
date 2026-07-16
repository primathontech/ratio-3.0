// In-memory ReleaseDB for local proofs. Models the atomicity guarantees the real Postgres impl
// must provide: commit() writes content+release+outbox in one shot (all-or-nothing), a
// serialized per-tenant publisher lock, and monotonic release ids.

import type { ReleaseDB, RouteInput, Manifest } from './publisher';

interface Rel {
  releaseId: number;
  tenantId: string;
  status: string;
  manifest: Manifest;
}

export class FakeReleaseDB implements ReleaseDB {
  private seq = 0;
  private rels = new Map<number, Rel>();
  private outbox: { releaseId: number; tenantId: string; state: string }[] = [];
  private locks = new Set<string>(); // per-tenant serialization
  queries = 0;

  async commit(tenantId: string, routes: RouteInput[], themeVersion: string): Promise<number> {
    this.queries++;
    const releaseId = ++this.seq; // global monotonic
    const manifest: Manifest = {
      releaseId,
      tenantId,
      routes: routes.map((r) => new URL('https://x' + r.path).pathname.replace(/\/$/, '') || '/'),
      themeVersion,
    };
    // atomic: release row + outbox row together
    this.rels.set(releaseId, { releaseId, tenantId, status: 'building', manifest });
    this.outbox.push({ releaseId, tenantId, state: 'pending' });
    return releaseId;
  }
  async getManifest(releaseId: number) {
    return this.rels.get(releaseId)?.manifest ?? null;
  }
  async setStatus(releaseId: number, status: string) {
    const r = this.rels.get(releaseId);
    if (r) {
      // supersede the previous active release when a new one activates
      if (status === 'active')
        for (const [, o] of this.rels)
          if (o.tenantId === r.tenantId && o.status === 'active' && o.releaseId !== releaseId)
            o.status = 'superseded';
      r.status = status;
    }
  }
  async drainOutbox(tenantId: string) {
    return this.outbox
      .filter((o) => o.tenantId === tenantId && o.state === 'pending')
      .map((o) => o.releaseId)
      .sort((a, b) => a - b);
  }
  async markOutboxDone(releaseId: number) {
    for (const o of this.outbox) if (o.releaseId === releaseId) o.state = 'done';
  }
  async currentActive(tenantId: string) {
    let max: number | null = null;
    for (const [, r] of this.rels)
      if (r.tenantId === tenantId && r.status === 'active') max = Math.max(max ?? 0, r.releaseId);
    return max;
  }

  // per-tenant serialized section (models SELECT ... FOR UPDATE on the tenant row / advisory lock)
  async withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(tenantId))
      throw new Error('tenant publish already in progress: ' + tenantId);
    this.locks.add(tenantId);
    try {
      return await fn();
    } finally {
      this.locks.delete(tenantId);
    }
  }

  // test introspection
  status(releaseId: number) {
    return this.rels.get(releaseId)?.status;
  }
  activeCount(tenantId: string) {
    return [...this.rels.values()].filter((r) => r.tenantId === tenantId && r.status === 'active')
      .length;
  }
}
