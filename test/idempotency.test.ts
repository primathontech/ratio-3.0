// OFCE-412 / audit M-5: the idempotency store dedupes by key, doesn't dedupe without one,
// and never caches failures (so a failed attempt can be retried).
import { test } from 'node:test';
import assert from 'node:assert';
import { createIdempotencyStore } from '../services/admin-api/idempotency';

test('same key runs the work once and returns the same result', async () => {
  const store = createIdempotencyStore();
  let calls = 0;
  const thunk = async () => ({ n: ++calls });
  const a = await store.run('k1', thunk);
  const b = await store.run('k1', thunk);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(a, b);
});

test('different keys and null keys are not deduped', async () => {
  const store = createIdempotencyStore();
  let calls = 0;
  const thunk = async () => ++calls;
  await store.run('a', thunk);
  await store.run('b', thunk);
  assert.strictEqual(calls, 2);
  await store.run(null, thunk);
  await store.run(null, thunk);
  assert.strictEqual(calls, 4); // null key never dedupes
});

test('a failed attempt is not cached — a retry re-runs', async () => {
  const store = createIdempotencyStore();
  let calls = 0;
  const bad = async () => {
    calls++;
    throw new Error('boom');
  };
  await assert.rejects(() => store.run('kf', bad));
  await assert.rejects(() => store.run('kf', bad));
  assert.strictEqual(calls, 2);
});

test('entries expire after the TTL', async () => {
  let t = 1000;
  const store = createIdempotencyStore({ ttlMs: 100, now: () => t });
  let calls = 0;
  const thunk = async () => ++calls;
  await store.run('k', thunk);
  await store.run('k', thunk);
  assert.strictEqual(calls, 1);
  t += 200; // past TTL
  await store.run('k', thunk);
  assert.strictEqual(calls, 2);
});

test('expired entries are swept, not just skipped — memory stays bounded (M-1)', async () => {
  let t = 0;
  const store = createIdempotencyStore({ ttlMs: 100, now: () => t });
  await store.run('a', async () => 1);
  await store.run('b', async () => 1);
  assert.strictEqual(store.size(), 2);
  t = 201; // past TTL for a and b
  await store.run('c', async () => 1); // sweeps a + b, then adds c
  assert.strictEqual(store.size(), 1);
});
