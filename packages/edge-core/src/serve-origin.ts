import type { CircuitBreaker } from './circuit-breaker';

// S4 Tier-1 (read survival): the edge keeps a last-good copy of cacheable GETs. If the origin
// is unreachable or 5xxs, we serve that copy (marked x-ratio-stale) rather than failing the
// whole request. Writes are never served stale — a durable mutation can't be faked from cache,
// so a failed write propagates honestly (Tier-2). `cache` is caches.default in the Cloudflare
// Worker; injectable here so the behaviour is provable in-process and reusable by any adapter.
export interface EdgeCache {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}
function markStale(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('x-ratio-stale', '1');
  return new Response(res.body, { status: res.status, headers: h });
}

// Cacheability + freshness (read-through). A response is edge-cacheable only if it declares a positive
// shared TTL (s-maxage, else max-age) — which excludes every no-store page (they carry none), so a
// per-user /cart or /order is never stored or served from a shared cache. `x-ratio-cached-at` is the
// wall-clock stamp written on put; freshness compares its age against the TTL, so only a still-fresh
// copy short-circuits the origin (a stale one falls through to revalidate, and is served ONLY on a
// later origin failure via markStale). The stamp is an internal header, stripped before the client.
const CACHED_AT = 'x-ratio-cached-at';
function ttlSeconds(res: Response): number | null {
  const cc = res.headers.get('cache-control') ?? '';
  if (/\b(no-store|private)\b/.test(cc)) return null;
  const m = /\bs-maxage=(\d+)/.exec(cc) ?? /\bmax-age=(\d+)/.exec(cc);
  return m ? Number(m[1]) : null;
}
function isCacheable(res: Response): boolean {
  const ttl = ttlSeconds(res);
  return ttl !== null && ttl > 0;
}
function stampCachedAt(res: Response, now: number): Response {
  const h = new Headers(res.headers);
  h.set(CACHED_AT, String(now));
  return new Response(res.body, { status: res.status, headers: h });
}
function isFresh(res: Response, now: number): boolean {
  const ttl = ttlSeconds(res);
  const at = Number(res.headers.get(CACHED_AT));
  if (ttl === null || !at) return false;
  return (now - at) / 1000 < ttl;
}
// Origin call budget (ADR-008 D-R3). A hung origin (slow, not dead) is the common failure —
// without a deadline the edge request hangs with it. Aborting on timeout turns "hung" into a
// rejection, which the stale-if-error catch below already handles → the cached page serves fast.
const ORIGIN_TIMEOUT_MS = 1500;
// A write (POST /cart, /checkout, /api/island…) can never serve stale, so the fast read-survival
// abort has no upside for it — it only turns a slow-but-succeeding mutation into a 503. Give writes
// a real budget instead (well under Cloudflare's ~30s subrequest cap); a genuinely dead origin
// still propagates honestly via the catch below.
const ORIGIN_WRITE_TIMEOUT_MS = 10000;
export async function fetchViaOrigin(
  req: Request,
  target: string,
  init: RequestInit & { duplex?: 'half' },
  cache: EdgeCache | undefined,
  doFetch: typeof fetch = fetch,
  timeoutMs: number = ORIGIN_TIMEOUT_MS,
  breaker?: CircuitBreaker
): Promise<Response> {
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const canServeStale = isRead && !!cache;
  const now = Date.now();
  // Reads race the read-survival budget (abort fast → serve stale); writes get a real budget.
  const budgetMs = isRead ? timeoutMs : ORIGIN_WRITE_TIMEOUT_MS;
  const serveStale = async (): Promise<Response | null> => {
    if (!canServeStale) return null;
    const stale = await cache!.match(req);
    return stale ? markStale(stale) : null;
  };

  // Read-through: a still-FRESH cached copy serves without touching the origin — repeat views are
  // edge-fast and the origin is shielded from the read-timeout entirely. A miss or a stale copy falls
  // through to revalidate below (a stale copy is only served later on an actual origin failure).
  if (canServeStale) {
    const hit = await cache!.match(req);
    if (hit && isFresh(hit, now)) return hit;
  }

  // Breaker open → don't even attempt the dead origin; serve stale now, skipping the timeout wait.
  if (breaker && !breaker.canAttempt()) {
    const stale = await serveStale();
    if (stale) return stale;
    throw new Error('origin circuit open');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await doFetch(target, { ...init, signal: controller.signal });
    if (res.status >= 500) {
      breaker?.onFailure();
      const stale = await serveStale();
      if (stale) return stale;
    } else {
      breaker?.onSuccess();
      // Store ONLY genuinely cacheable responses (a positive shared TTL) — never a no-store per-user
      // page. Stamp the cache time so the read-through above can judge freshness. (put can still reject
      // e.g. a Set-Cookie response; that's fine — it simply won't be cached.)
      if (canServeStale && res.ok && isCacheable(res)) {
        try {
          await cache!.put(req, stampCachedAt(res.clone(), now));
        } catch {
          /* uncacheable — skip */
        }
      }
    }
    return res;
  } catch (err) {
    breaker?.onFailure();
    const stale = await serveStale();
    if (stale) return stale;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
