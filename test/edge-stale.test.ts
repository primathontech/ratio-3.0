// S4 Tier-1 (read survival): if the origin is unreachable or 5xxs, the edge serves the
// last-good copy from its cache (marked stale) instead of failing the whole request. Writes
// never serve stale — a durable mutation can't be faked. fetch + cache are injected so we
// prove the control flow without Cloudflare. See apps/edge/worker.ts::fetchViaOrigin.
import { test } from 'node:test';
import assert from 'node:assert';
import { fetchViaOrigin, createCircuitBreaker, type EdgeCache } from '../packages/edge-core/index';

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
