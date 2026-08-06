// S2/KV: host->tenant resolution reads the edge key-value store first (edge-local, sub-ms, and
// survives DB death for already-cached routing) and hits Postgres only on a miss, then populates
// it. Postgres stays source of truth; the control plane write-throughs the key on domain
// verify/reassign/suspend so the cache doesn't drift. `kv` and `dbQuery` are injected, so the
// same logic runs over Workers KV today and EdgeKV on Akamai.
export interface TenantKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
// Positive entries carry a backstop TTL in case a control-plane write-through is ever missed;
// negatives are short so a freshly-onboarded domain resolves quickly, while bogus/attack
// hostnames can't fall through to the DB on every request (a load-amplification guard).
const KV_TTL_HIT = 3600;
const KV_TTL_MISS = 60;
// The routing DB lookup runs on every KV miss; without a deadline a hung Neon query hangs the
// whole request (ADR-008 D-R3). On timeout we throw and DO NOT populate KV — caching a negative
// on a transient blip would 404 a real store for KV_TTL_MISS seconds. The pending query can't be
// cancelled (Neon over race), so it's left to GC; correctness is in not persisting its result.
const DB_TIMEOUT_MS = 800;
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function lookupTenant(
  host: string,
  kv: TenantKV | undefined,
  dbQuery: (host: string) => Promise<string | null>,
  dbTimeoutMs: number = DB_TIMEOUT_MS
): Promise<string | null> {
  const key = `host:${host}`;
  if (kv) {
    const cached = await kv.get(key);
    if (cached !== null) return (JSON.parse(cached) as { t: string | null }).t;
  }
  const tenantId = await withTimeout(dbQuery(host), dbTimeoutMs, 'tenant db lookup');
  if (kv) {
    await kv.put(key, JSON.stringify({ t: tenantId }), {
      expirationTtl: tenantId ? KV_TTL_HIT : KV_TTL_MISS,
    });
  }
  return tenantId;
}
