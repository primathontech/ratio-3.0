// L1: the readiness probe must be cached so an unauthenticated /ready flood can't run one DB
// query per request.
import { test } from 'node:test';
import assert from 'node:assert';
import { createReadiness } from '../services/admin-api/readiness';

test('caches the probe within the TTL (one probe per window)', async () => {
  let calls = 0;
  let clock = 0;
  const ready = createReadiness(
    async () => {
      calls++;
    },
    { ttlMs: 1000, now: () => clock }
  );
  assert.strictEqual(await ready(), true);
  assert.strictEqual(await ready(), true);
  assert.strictEqual(await ready(), true);
  assert.strictEqual(calls, 1); // cached — the DB was queried once

  clock = 1500; // past the window
  assert.strictEqual(await ready(), true);
  assert.strictEqual(calls, 2);
});

test('reflects a failing probe as not-ready, and re-probes after the window', async () => {
  let fail = true;
  let clock = 0;
  const ready = createReadiness(
    async () => {
      if (fail) throw new Error('db down');
    },
    { ttlMs: 1000, now: () => clock }
  );
  assert.strictEqual(await ready(), false);
  fail = false;
  assert.strictEqual(await ready(), false); // still cached-unavailable within the window
  clock = 1500;
  assert.strictEqual(await ready(), true); // recovered after the window
});

test('coalesces concurrent probes onto a single in-flight query', async () => {
  let calls = 0;
  const ready = createReadiness(
    () =>
      new Promise<void>((resolve) => {
        calls++;
        setTimeout(resolve, 5);
      }),
    { ttlMs: 1000, now: () => 0 }
  );
  const [a, b, c] = await Promise.all([ready(), ready(), ready()]);
  assert.deepStrictEqual([a, b, c], [true, true, true]);
  assert.strictEqual(calls, 1);
});
