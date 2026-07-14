// H-1 (rate-limit half): the shared Postgres limiter must enforce ONE limit across instances,
// unlike the process-local in-memory limiter (which becomes N× at scale). And it must fail
// OPEN on a DB error so a limiter outage never takes down the API (ADR-008).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createPgRateLimiter } from '../packages/shared/ratelimit';
import { pool } from '../packages/shared/db';

const KEY = 'test:pgrl:shared';
before(() => pool.query('DELETE FROM rate_counters WHERE key = $1', [KEY]));
after(async () => {
  await pool.query('DELETE FROM rate_counters WHERE key = $1', [KEY]);
  await pool.end();
});

test('two limiter instances share one limit over the same key (cross-instance)', async () => {
  const a = createPgRateLimiter(pool, { limit: 3, windowMs: 60_000 });
  const b = createPgRateLimiter(pool, { limit: 3, windowMs: 60_000 }); // simulates a 2nd task
  assert.strictEqual((await a.check(KEY)).allowed, true); // 1
  assert.strictEqual((await b.check(KEY)).allowed, true); // 2
  assert.strictEqual((await a.check(KEY)).allowed, true); // 3
  assert.strictEqual((await b.check(KEY)).allowed, false); // 4th → over the shared limit of 3
});

test('starts a fresh window once the current one has elapsed', async () => {
  const rl = createPgRateLimiter(pool, { limit: 1, windowMs: 60_000 });
  assert.strictEqual((await rl.check(KEY + ':w')).allowed, true);
  assert.strictEqual((await rl.check(KEY + ':w')).allowed, false); // over limit 1
  // Force the window to have elapsed, then it should allow again.
  await pool.query(
    "UPDATE rate_counters SET reset_at = now() - interval '1 second' WHERE key = $1",
    [KEY + ':w']
  );
  assert.strictEqual((await rl.check(KEY + ':w')).allowed, true);
  await pool.query('DELETE FROM rate_counters WHERE key = $1', [KEY + ':w']);
});

test('fails open (allowed) when the backing store errors', async () => {
  const boom = {
    query: async () => {
      throw new Error('db down');
    },
  };
  const rl = createPgRateLimiter(boom, { limit: 1, windowMs: 60_000 });
  const r = await rl.check('anything');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.failOpen, true);
});
