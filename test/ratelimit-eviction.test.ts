// L1: the in-process rate limiter kept one entry per distinct key forever — a slow unbounded
// memory leak on a long-lived container. It must evict expired windows (like the idempotency
// store sweeps), bounded to once per window so the sweep cost stays amortized-cheap.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRateLimiter } from '../packages/shared/ratelimit';

test('expired windows are evicted so the store does not grow unboundedly', () => {
  const store = new Map();
  let clock = 0;
  const rl = createRateLimiter({ limit: 5, windowMs: 1000, now: () => clock, store });

  rl.check('u1');
  rl.check('u2');
  rl.check('u3');
  assert.strictEqual(store.size, 3);

  // Past the window and past the sweep interval: the next check sweeps u1..u3 (all expired).
  clock = 2500;
  rl.check('u4');
  assert.strictEqual(store.size, 1);
  assert.deepStrictEqual([...store.keys()], ['u4']);
});

test('a still-live window is not evicted, and limiting still works after a sweep', () => {
  const store = new Map();
  let clock = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock, store });

  assert.strictEqual(rl.check('u1').allowed, true);
  assert.strictEqual(rl.check('u1').allowed, true);
  assert.strictEqual(rl.check('u1').allowed, false); // over budget within the window

  // New window: sweep drops the old u1 entry, and u1 gets a fresh budget.
  clock = 1500;
  assert.strictEqual(rl.check('u1').allowed, true);
  assert.strictEqual(store.size, 1);
});
