// Per-tenant rate limit (ADR-001 D-MT6) + fail-open on backing-store failure
// (ADR-008). Pure unit — injected clock + store keep it deterministic (no real
// time/network). Written test-first. Backing store is external (Redis) so a
// failing store stub is a legit mock; our own logic is never mocked.
const { test } = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../src/ratelimit');

test('allows up to the limit, then blocks (per window)', () => {
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
  assert.strictEqual(rl.check('t_a').allowed, true);
  assert.strictEqual(rl.check('t_a').allowed, true);
  assert.strictEqual(rl.check('t_a').allowed, true);
  assert.strictEqual(rl.check('t_a').allowed, false); // 4th over limit 3
});

test('limits are per-tenant (noisy tenant does not affect another)', () => {
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  assert.strictEqual(rl.check('t_a').allowed, true);
  assert.strictEqual(rl.check('t_a').allowed, false); // t_a exhausted
  assert.strictEqual(rl.check('t_b').allowed, true); // t_b unaffected
});

test('window resets after windowMs (deterministic via injected clock)', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.strictEqual(rl.check('t_a').allowed, true);
  assert.strictEqual(rl.check('t_a').allowed, false);
  t = 1000; // window elapsed
  assert.strictEqual(rl.check('t_a').allowed, true);
});

test('fail-open: if the backing store throws, allow (never block on limiter failure)', () => {
  const badStore = { get() { throw new Error('redis down'); }, set() {} };
  const rl = createRateLimiter({ limit: 1, store: badStore });
  const r = rl.check('t_a');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.failOpen, true);
});

test('requires a tenantId', () => {
  const rl = createRateLimiter();
  assert.throws(() => rl.check());
});
