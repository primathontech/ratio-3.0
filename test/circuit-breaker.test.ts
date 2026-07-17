// S4 D-R3: a per-dependency circuit breaker. After N consecutive failures it "opens" and, for a
// cooldown window, callers fail fast without even attempting the dead dependency (so during an
// origin outage every shopper skips the timeout wait). After cooldown it "half-opens" — one trial
// is allowed; success closes it, failure re-opens for another cooldown. Clock is injected so the
// state machine is proven deterministically. See apps/edge/worker.ts::createCircuitBreaker.
import { test } from 'node:test';
import assert from 'node:assert';
import { createCircuitBreaker } from '../apps/edge/worker';

test('closed → open only after threshold CONSECUTIVE failures', () => {
  const t = 0;
  const b = createCircuitBreaker(3, 1000, () => t);
  assert.strictEqual(b.canAttempt(), true);
  b.onFailure();
  b.onFailure();
  assert.strictEqual(b.canAttempt(), true); // 2 < 3
  b.onFailure();
  assert.strictEqual(b.canAttempt(), false); // tripped
});

test('open blocks until the cooldown elapses, then half-opens for a trial', () => {
  let t = 0;
  const b = createCircuitBreaker(1, 1000, () => t);
  b.onFailure();
  assert.strictEqual(b.canAttempt(), false);
  t = 999;
  assert.strictEqual(b.canAttempt(), false);
  t = 1000;
  assert.strictEqual(b.canAttempt(), true); // half-open trial allowed
});

test('a success closes the breaker and resets the failure count', () => {
  const t = 0;
  const b = createCircuitBreaker(2, 1000, () => t);
  b.onFailure();
  b.onSuccess();
  b.onFailure();
  assert.strictEqual(b.canAttempt(), true); // count was reset — only 1 failure since
});

test('a failure during half-open re-opens for another full cooldown', () => {
  let t = 0;
  const b = createCircuitBreaker(1, 1000, () => t);
  b.onFailure();
  t = 1000;
  assert.strictEqual(b.canAttempt(), true); // half-open
  b.onFailure(); // trial failed → re-open at t=1000
  assert.strictEqual(b.canAttempt(), false);
  t = 1999;
  assert.strictEqual(b.canAttempt(), false);
  t = 2000;
  assert.strictEqual(b.canAttempt(), true);
});
