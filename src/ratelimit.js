// Per-tenant fixed-window rate limit (ADR-001 D-MT6). Fail-open on backing-store
// failure (ADR-008): a limiter outage must never take the site down. The store is
// a Map here; on the real stack it's Redis (same interface: get/set by tenantId).
// Clock + store are injectable for deterministic tests.
function createRateLimiter({ limit = 100, windowMs = 60_000, now = () => Date.now(), store = new Map() } = {}) {
  return {
    check(tenantId) {
      if (!tenantId || typeof tenantId !== 'string') {
        throw new Error('rate limit requires a tenantId');
      }
      try {
        const t = now();
        const entry = store.get(tenantId);
        if (!entry || t >= entry.reset) {
          store.set(tenantId, { count: 1, reset: t + windowMs });
          return { allowed: true, remaining: limit - 1 };
        }
        if (entry.count < limit) {
          entry.count += 1;
          store.set(tenantId, entry);
          return { allowed: true, remaining: limit - entry.count };
        }
        return { allowed: false, remaining: 0 };
      } catch {
        return { allowed: true, remaining: null, failOpen: true };
      }
    },
  };
}

module.exports = { createRateLimiter };
