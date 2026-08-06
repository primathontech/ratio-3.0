// Cache the readiness probe (audit L1): /ready is unauthenticated and, having no userId,
// bypasses the per-user rate limiter — without this, a flood of probes would run one DB
// query each. A short TTL keeps a real outage promptly visible; concurrent probes within a
// window are coalesced onto a single in-flight query.
export function createReadiness(
  probe: () => Promise<void>,
  { ttlMs = 2000, now = () => Date.now() }: { ttlMs?: number; now?: () => number } = {}
): () => Promise<boolean> {
  let cache: { at: number; ok: boolean } | null = null;
  let inflight: Promise<boolean> | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.ok;
    if (inflight) return inflight;
    inflight = (async () => {
      let ok: boolean;
      try {
        await probe();
        ok = true;
      } catch {
        ok = false;
      }
      cache = { at: now(), ok };
      inflight = null;
      return ok;
    })();
    return inflight;
  };
}
