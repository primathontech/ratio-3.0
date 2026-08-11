// S4 Tier-1 (read survival): if the origin is unreachable or 5xxs, the edge serves the
// last-good copy from its cache (marked stale) instead of failing the whole request. Writes
// never serve stale — a durable mutation can't be faked. fetch + cache are injected so we
// prove the control flow without Cloudflare. See apps/edge/worker.ts::fetchViaOrigin.
import { test } from 'node:test';
import assert from 'node:assert';
import { fetchViaOrigin, createCircuitBreaker, type EdgeCache } from '@ratio/edge-core';

function memCache(seed?: { req: Request; res: Response }): EdgeCache {
  const store = new Map<string, Response>();
  const key = (r: Request) => `${r.method} ${r.url}`;
  if (seed) store.set(key(seed.req), seed.res);
  return {
    async match(req) {
      return store.get(key(req));
    },
    async put(req, res) {
      store.set(key(req), res);
    },
  };
}

const throws = (async () => {
  throw new Error('origin unreachable');
}) as unknown as typeof fetch;

// Never resolves on its own — the only way out is the caller aborting via init.signal.
// Lets us prove the timeout deterministically (outcome depends on abort, not on wall-clock).
const hangsUntilAborted = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted', 'AbortError'))
    );
  })) as unknown as typeof fetch;

// Resolves after `ms`, unless aborted first (then rejects, like a real fetch). Lets us prove which
// requests are bound by which timeout: an origin slower than the read budget but faster than the
// write budget resolves for a write but is aborted for a read.
const resolvesAfter = (ms: number, res: Response) =>
  ((_url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(res), ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    })) as unknown as typeof fetch;

test('Tier-1: serves stale from cache when the origin throws', async () => {
  const req = new Request('https://shop.example/');
  const good = new Response('<h1>last good</h1>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const cache = memCache({ req, res: good });

  const res = await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, throws);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-ratio-stale'), '1');
  assert.strictEqual(await res.text(), '<h1>last good</h1>');
});

test('Tier-1: serves stale when the origin 5xxs', async () => {
  const req = new Request('https://shop.example/');
  const cache = memCache({ req, res: new Response('ok', { status: 200 }) });
  const five = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;

  const res = await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, five);
  assert.strictEqual(res.headers.get('x-ratio-stale'), '1');
  assert.strictEqual(await res.text(), 'ok');
});

test('honest: uncached GET + origin down → error propagates (cannot serve what we never cached)', async () => {
  const req = new Request('https://shop.example/');
  const cache = memCache();
  await assert.rejects(fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, throws));
});

test('writes (POST /cart) never serve stale — origin failure propagates', async () => {
  const req = new Request('https://shop.example/cart', { method: 'POST' });
  const cache = memCache({ req: new Request('https://shop.example/cart'), res: new Response('x') });
  await assert.rejects(
    fetchViaOrigin(req, 'https://origin/cart', { method: 'POST' }, cache, throws)
  );
});

test(
  'D-R3: a hung origin aborts on timeout and serves stale (fast, no hang)',
  { timeout: 1000 },
  async () => {
    const req = new Request('https://shop.example/');
    const cache = memCache({ req, res: new Response('cached', { status: 200 }) });
    const res = await fetchViaOrigin(
      req,
      'https://origin/',
      { method: 'GET' },
      cache,
      hangsUntilAborted,
      10
    );
    assert.strictEqual(res.headers.get('x-ratio-stale'), '1');
    assert.strictEqual(await res.text(), 'cached');
  }
);

test(
  'D-R3: a fast origin under budget is not aborted and serves fresh',
  { timeout: 1000 },
  async () => {
    const req = new Request('https://shop.example/');
    const cache = memCache();
    const ok = (async () =>
      new Response('fresh', {
        status: 200,
        headers: { 'cache-control': 'public, s-maxage=300' },
      })) as unknown as typeof fetch;
    const res = await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, ok, 1000);
    assert.strictEqual(res.headers.get('x-ratio-stale'), null);
    assert.strictEqual(await res.text(), 'fresh');
  }
);

test(
  'D-R3: a hung origin with no cached copy fails fast rather than hanging',
  { timeout: 1000 },
  async () => {
    const req = new Request('https://shop.example/');
    const cache = memCache();
    await assert.rejects(
      fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, hangsUntilAborted, 10)
    );
  }
);

test('D-R3 breaker: once the origin trips the breaker, later requests serve stale WITHOUT calling it', async () => {
  const req = new Request('https://shop.example/');
  const cache = memCache({ req, res: new Response('cached', { status: 200 }) });
  let calls = 0;
  const failing = (async () => {
    calls += 1;
    throw new Error('origin down');
  }) as unknown as typeof fetch;
  let t = 0;
  const breaker = createCircuitBreaker(1, 1000, () => t);

  // 1st: origin is tried, fails, serves stale, trips the breaker.
  const first = await fetchViaOrigin(
    req,
    'https://origin/',
    { method: 'GET' },
    cache,
    failing,
    50,
    breaker
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.headers.get('x-ratio-stale'), '1');

  // 2nd (breaker open): origin is NOT called; stale served immediately.
  const second = await fetchViaOrigin(
    req,
    'https://origin/',
    { method: 'GET' },
    cache,
    failing,
    50,
    breaker
  );
  assert.strictEqual(calls, 1, 'origin must not be called while the breaker is open');
  assert.strictEqual(second.headers.get('x-ratio-stale'), '1');

  // After cooldown: half-open, origin retried; on success the breaker closes.
  t = 1000;
  const ok = (async () => new Response('fresh', { status: 200 })) as unknown as typeof fetch;
  const third = await fetchViaOrigin(
    req,
    'https://origin/',
    { method: 'GET' },
    cache,
    ok,
    50,
    breaker
  );
  assert.strictEqual(third.headers.get('x-ratio-stale'), null);
  assert.strictEqual(await third.text(), 'fresh');
});

test(
  'D-R3: a write is NOT aborted at the short read-survival budget (add-to-cart 503 repro)',
  { timeout: 2000 },
  async () => {
    // The origin takes 40ms (2 sequential GoKwik calls). The read budget is a tiny 10ms. A write
    // can never serve stale, so aborting it at the read budget only turns a slow-but-succeeding
    // cart-add into a 503 — it must instead get its own, longer budget and complete.
    const req = new Request('https://shop.example/cart/add', { method: 'POST' });
    const slowOk = resolvesAfter(40, new Response('added', { status: 200 }));
    const res = await fetchViaOrigin(
      req,
      'https://origin/cart/add',
      { method: 'POST' },
      memCache(),
      slowOk,
      10 // read budget — must NOT bound the write
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'added');
  }
);

test(
  'D-R3: a read IS still bound by the read-survival budget (unchanged)',
  { timeout: 2000 },
  async () => {
    const req = new Request('https://shop.example/');
    const slowOk = resolvesAfter(40, new Response('fresh', { status: 200 }));
    // GET slower than the 10ms read budget, no cached copy → aborts and propagates (no hang).
    await assert.rejects(
      fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, memCache(), slowOk, 10)
    );
  }
);

test('a successful GET is stored so it can be served stale later', async () => {
  const req = new Request('https://shop.example/');
  const cache = memCache();
  const ok = (async () =>
    new Response('fresh', {
      status: 200,
      headers: { 'cache-control': 'public, s-maxage=300' },
    })) as unknown as typeof fetch;

  const res = await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, ok);
  assert.strictEqual(await res.text(), 'fresh');
  assert.ok(await cache.match(req), 'response should be cached for stale fallback');
});

// ── Read-through (S4 Tier-1 upgrade): a FRESH cacheable copy serves without touching the origin, so
// repeat views are edge-fast and the origin is shielded from the read-timeout entirely. ──
const cacheableRes = (body: string, opts: { ageMs?: number; ttl?: number } = {}) =>
  new Response(body, {
    status: 200,
    headers: {
      'cache-control': `public, s-maxage=${opts.ttl ?? 300}, stale-while-revalidate=86400`,
      // The freshness stamp fetchViaOrigin writes on put; seed it here to simulate an aged entry.
      'x-ratio-cached-at': String(Date.now() - (opts.ageMs ?? 0)),
    },
  });

test('read-through: a FRESH cacheable copy is served without calling the origin', async () => {
  const req = new Request('https://shop.example/');
  const cache = memCache({
    req,
    res: cacheableRes('<h1>cached</h1>', { ageMs: 10_000, ttl: 300 }),
  });
  let calls = 0;
  const origin = (async () => {
    calls += 1;
    return new Response('origin', { status: 200 });
  }) as unknown as typeof fetch;

  const res = await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, origin);
  assert.strictEqual(calls, 0, 'a fresh cache hit must NOT call the origin');
  assert.strictEqual(await res.text(), '<h1>cached</h1>');
});

test('read-through: a STALE copy does not short-circuit — the origin is called for fresh content', async () => {
  const req = new Request('https://shop.example/');
  // 400s old but only 300s fresh → stale; must re-fetch rather than serve as fresh.
  const cache = memCache({ req, res: cacheableRes('old', { ageMs: 400_000, ttl: 300 }) });
  let calls = 0;
  const origin = (async () => {
    calls += 1;
    return new Response('new', {
      status: 200,
      headers: { 'cache-control': 'public, s-maxage=300' },
    });
  }) as unknown as typeof fetch;

  const res = await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, origin);
  assert.strictEqual(calls, 1, 'a stale copy must not be served as fresh');
  assert.strictEqual(await res.text(), 'new');
});

test('read-through never caches a no-store response (per-user /cart must not be shared)', async () => {
  const req = new Request('https://shop.example/cart');
  const cache = memCache();
  // A no-store page carries no Cache-Control TTL (only the origin's internal x-cache, stripped later).
  const origin = (async () =>
    new Response('user cart', {
      status: 200,
      headers: { 'x-cache': 'no-store' },
    })) as unknown as typeof fetch;

  await fetchViaOrigin(req, 'https://origin/cart', { method: 'GET' }, cache, origin);
  assert.strictEqual(await cache.match(req), undefined, 'a no-store page must never be stored');
});

test('a Set-Cookie response is never cached even if it declares a TTL (per-user leak guard)', async () => {
  const req = new Request('https://shop.example/');
  const cache = memCache();
  const origin = (async () =>
    new Response('personalized', {
      status: 200,
      headers: { 'cache-control': 'public, s-maxage=300', 'set-cookie': 'sid=user-A' },
    })) as unknown as typeof fetch;

  await fetchViaOrigin(req, 'https://origin/', { method: 'GET' }, cache, origin);
  assert.strictEqual(
    await cache.match(req),
    undefined,
    'a Set-Cookie response must never be shared'
  );
});
