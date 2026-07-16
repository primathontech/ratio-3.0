// Fault-injectable in-memory fakes of the four edge dependencies (KV, R2, Cache API, origin).
// They mirror the semantics the spec relies on so P1–P13 + E0 are provable locally in node:test,
// without a live Cloudflare account. The production edge binds the real bindings behind the same
// tiny interfaces (get/put/match), so the algorithm in edge.ts is identical in both worlds.

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, val: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface R2Like {
  get(key: string): Promise<StoredResponse | null>;
  put(key: string, val: StoredResponse): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
// A cached HTTP response reduced to what actually matters + must survive: status, a header
// allowlist, and body. NO Set-Cookie, NO per-user headers — enforced at write time (P10).
export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  checksum: string; // sha256 of status+headers+body — used by P3 completeness verification
}

// A fault the tests toggle. `down` = every op throws (models an outage); `slowMs` models latency.
export class Fault {
  down = false;
  reads = 0;
  writes = 0;
  reset() {
    this.down = false;
    this.reads = 0;
    this.writes = 0;
  }
}

export class FakeKV implements KVLike {
  private m = new Map<string, string>();
  constructor(public fault = new Fault()) {}
  async get(key: string) {
    if (this.fault.down) throw new Error('KV down');
    this.fault.reads++;
    return this.m.has(key) ? this.m.get(key)! : null;
  }
  async put(key: string, val: string) {
    if (this.fault.down) throw new Error('KV down');
    this.fault.writes++;
    this.m.set(key, val);
  }
  async delete(key: string) {
    if (this.fault.down) throw new Error('KV down');
    this.m.delete(key);
  }
  raw() {
    return this.m;
  }
}

export class FakeR2 implements R2Like {
  private m = new Map<string, StoredResponse>();
  constructor(public fault = new Fault()) {}
  async get(key: string) {
    if (this.fault.down) throw new Error('R2 down');
    this.fault.reads++;
    return this.m.get(key) ?? null;
  }
  async put(key: string, val: StoredResponse) {
    if (this.fault.down) throw new Error('R2 down');
    this.fault.writes++;
    this.m.set(key, val);
  }
  async list(prefix: string) {
    if (this.fault.down) throw new Error('R2 down');
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  // test-only corruption for P3
  corrupt(key: string) {
    const v = this.m.get(key);
    if (v) this.m.set(key, { ...v, body: v.body + ' [CORRUPTED]' });
  }
  raw() {
    return this.m;
  }
}

// Per-PoP HTTP cache. Honors nothing but explicit eviction + our own TTL bookkeeping — the real
// Cache API keys on a Request; here we key on a string. Crucially per-instance, so tests spin up
// one FakeCache per simulated PoP to prove the "per-colo, not global" property (P6/P15).
export class FakeCache {
  private m = new Map<string, { val: StoredResponse; expEpoch: number }>();
  constructor(private clock: () => number) {}
  async match(key: string): Promise<StoredResponse | null> {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.expEpoch <= this.clock()) {
      this.m.delete(key); // TTL expiry — models P11
      return null;
    }
    return e.val;
  }
  async put(key: string, val: StoredResponse, ttlSeconds: number) {
    this.m.set(key, { val, expEpoch: this.clock() + ttlSeconds * 1000 });
  }
  evict(key: string) {
    this.m.delete(key);
  }
}
