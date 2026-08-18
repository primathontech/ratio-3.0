// Commerce webhook (gokwik → cache invalidation). Public + HMAC-verified. In process via
// app.fetch(). purgeEdgeTags is a no-op off a dev machine, so no edge/network is needed here — we
// assert the event→tag mapping via the response, plus signature verification.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { createApp } from '../../app';
import { pool } from '@ratio/data-db';

const app = createApp(async () => null);
function post(body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request('http://cp/webhooks/commerce', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}
const purged = async (r: Response) => (await r.json()).purged;

after(() => pool.end());

test('product.updated → prod:<id>', async () => {
  const r = await post({ type: 'product.updated', data: { productId: '123' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await purged(r), ['prod:123']);
});

test('collection.updated → col:<handle>', async () => {
  const r = await post({ type: 'collection.updated', data: { handle: 'summer' } });
  assert.deepStrictEqual(await purged(r), ['col:summer']);
});

test('pricing/inventory bulk → prod:<id> per product', async () => {
  const r = await post({ type: 'pricing.updated', data: { productIds: ['a', 'b'] } });
  assert.deepStrictEqual(await purged(r), ['prod:a', 'prod:b']);
});

test('unknown event type → 200 with no tags (best-effort)', async () => {
  const r = await post({ type: 'foo.bar', data: {} });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await purged(r), []);
});

test('missing type → 400; invalid json → 400', async () => {
  assert.strictEqual((await post({ data: {} })).status, 400);
  assert.strictEqual((await post('not json')).status, 400);
});

test('HMAC: bad signature → 401, correct signature → 200 (when WEBHOOK_SECRET set)', async () => {
  process.env.WEBHOOK_SECRET = 'shh';
  try {
    const bodyStr = JSON.stringify({ type: 'product.updated', data: { productId: '9' } });
    const bad = await post(bodyStr, { 'x-webhook-signature': 'deadbeef' });
    assert.strictEqual(bad.status, 401);
    const sig = createHmac('sha256', 'shh').update(bodyStr).digest('hex');
    const good = await post(bodyStr, { 'x-webhook-signature': sig });
    assert.strictEqual(good.status, 200);
  } finally {
    delete process.env.WEBHOOK_SECRET;
  }
});
