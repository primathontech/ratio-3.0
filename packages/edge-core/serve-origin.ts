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
// Origin call budget (ADR-008 D-R3). A hung origin (slow, not dead) is the common failure —
// without a deadline the edge request hangs with it. Aborting on timeout turns "hung" into a
// rejection, which the stale-if-error catch below already handles → the cached page serves fast.
const ORIGIN_TIMEOUT_MS = 1500;
export async function fetchViaOrigin(
  req: Request,
  target: string,
  init: RequestInit & { duplex?: 'half' },
  cache: EdgeCache | undefined,
  doFetch: typeof fetch = fetch,
  timeoutMs: number = ORIGIN_TIMEOUT_MS,
  breaker?: CircuitBreaker
): Promise<Response> {
  const canServeStale = (req.method === 'GET' || req.method === 'HEAD') && !!cache;
  const serveStale = async (): Promise<Response | null> => {
    if (!canServeStale) return null;
    const stale = await cache!.match(req);
    return stale ? markStale(stale) : null;
  };

  // Breaker open → don't even attempt the dead origin; serve stale now, skipping the timeout wait.
  if (breaker && !breaker.canAttempt()) {
    const stale = await serveStale();
    if (stale) return stale;
    throw new Error('origin circuit open');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(target, { ...init, signal: controller.signal });
    if (res.status >= 500) {
      breaker?.onFailure();
      const stale = await serveStale();
      if (stale) return stale;
    } else {
      breaker?.onSuccess();
      if (canServeStale && res.ok) {
        // put rejects on no-store / Set-Cookie responses — those simply aren't stale-servable.
        try {
          await cache!.put(req, res.clone());
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
