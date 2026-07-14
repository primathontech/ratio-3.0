// H-1: the shared (Postgres-backed) idempotency store must dedupe + guarantee single execution
// ACROSS instances — otherwise a retried assistant run on another task re-executes the tool
// loop and duplicates stores/pages. These exercise the real table (concurrency + reclaim).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  createPgIdempotencyStore,
  IdempotencyInProgressError,
} from '../services/admin-api/idempotency';
import { pool } from '../packages/shared/db';

const KEYS = ['idem:one', 'idem:concurrent', 'idem:fail', 'idem:expired'];
async function clean() {
  await pool.query('DELETE FROM idempotency_keys WHERE key = ANY($1)', [KEYS]);
}
before(clean);
beforeEach(clean);
after(async () => {
  await clean();
  await pool.end();
});

test('runs the work once and returns the cached result on a repeat (cross-instance dedup)', async () => {
  const store = createPgIdempotencyStore(pool);
  let runs = 0;
  const thunk = async () => {
    runs++;
    return { reply: 'done', actions: [] };
  };
  const first = await store.run('idem:one', thunk);
  const second = await store.run('idem:one', thunk); // simulates a retry (possibly another task)
  assert.deepStrictEqual(first, { reply: 'done', actions: [] });
  assert.deepStrictEqual(second, first); // cached
  assert.strictEqual(runs, 1); // executed exactly once
});

test('concurrent runs execute once; the loser gets IdempotencyInProgressError', async () => {
  const store = createPgIdempotencyStore(pool);
  let runs = 0;
  const slow = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: true };
  };
  const results = await Promise.allSettled([
    store.run('idem:concurrent', slow),
    store.run('idem:concurrent', slow),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(runs, 1, 'the tool loop ran exactly once across the two calls');
  assert.strictEqual(fulfilled.length, 1);
  assert.strictEqual(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof IdempotencyInProgressError);
});

test('a failed run is not cached — the key is reclaimable and retries', async () => {
  const store = createPgIdempotencyStore(pool);
  await assert.rejects(
    () =>
      store.run('idem:fail', async () => {
        throw new Error('boom');
      }),
    /boom/
  );
  let ran = false;
  const out = await store.run('idem:fail', async () => {
    ran = true;
    return 'recovered';
  });
  assert.strictEqual(ran, true);
  assert.strictEqual(out, 'recovered');
});

test('an expired (crashed-owner) running row is reclaimed', async () => {
  const store = createPgIdempotencyStore(pool, { ttlMs: 30 });
  // Simulate a previous instance that claimed the key then died mid-run, 1s ago.
  await pool.query(
    `INSERT INTO idempotency_keys (key, status, created_at) VALUES ($1, 'running', now() - interval '1 second')`,
    ['idem:expired']
  );
  let ran = false;
  const out = await store.run('idem:expired', async () => {
    ran = true;
    return 'took-over';
  });
  assert.strictEqual(ran, true, 'the stale key was reclaimed and re-run');
  assert.strictEqual(out, 'took-over');
});
