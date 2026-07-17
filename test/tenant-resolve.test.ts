// S2/KV (Lakshay's deep-dive comment): the edge resolves host->tenant from Workers KV first,
// hitting Postgres only on a miss, then populating KV. This removes the per-request DB round
// trip and the DB-is-a-SPOF failure mode. These tests pin the caching contract: a KV hit must
// NOT touch the DB (that's the whole point), misses populate KV (positive long TTL / negative
// short TTL so bogus hosts can't hammer the DB), and a missing binding degrades to DB.
import { test } from 'node:test';
import assert from 'node:assert';
import { lookupTenant } from '../apps/edge/worker';

function fakeKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const puts: { key: string; value: string; ttl?: number }[] = [];
  const kv = {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v);
      puts.push({ key: k, value: v, ttl: opts?.expirationTtl });
    },
  };
  return { kv, puts };
}

function spyDb(result: string | null) {
  let calls = 0;
  return { fn: async () => ((calls += 1), result), calls: () => calls };
}

test('KV positive hit → returns tenant, DB not queried', async () => {
  const { kv } = fakeKV({ 'host:acme.ratiodev.in': JSON.stringify({ t: 't_acme' }) });
  const db = spyDb('t_should_not_be_used');
  assert.strictEqual(await lookupTenant('acme.ratiodev.in', kv, db.fn), 't_acme');
  assert.strictEqual(db.calls(), 0);
});

test('KV negative sentinel → returns null, DB not queried', async () => {
  const { kv } = fakeKV({ 'host:bogus.example': JSON.stringify({ t: null }) });
  const db = spyDb('t_x');
  assert.strictEqual(await lookupTenant('bogus.example', kv, db.fn), null);
  assert.strictEqual(db.calls(), 0);
});

test('KV miss + DB hit → returns tenant, writes positive key with long TTL', async () => {
  const { kv, puts } = fakeKV();
  const db = spyDb('t_acme');
  assert.strictEqual(await lookupTenant('acme.ratiodev.in', kv, db.fn), 't_acme');
  assert.strictEqual(db.calls(), 1);
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].key, 'host:acme.ratiodev.in');
  assert.deepStrictEqual(JSON.parse(puts[0].value), { t: 't_acme' });
  assert.strictEqual(puts[0].ttl, 3600);
});

test('KV miss + DB no-match → returns null, writes negative key with short TTL', async () => {
  const { kv, puts } = fakeKV();
  const db = spyDb(null);
  assert.strictEqual(await lookupTenant('nope.example', kv, db.fn), null);
  assert.strictEqual(db.calls(), 1);
  assert.deepStrictEqual(JSON.parse(puts[0].value), { t: null });
  assert.strictEqual(puts[0].ttl, 60);
});

test('no KV binding → falls back to DB, no throw', async () => {
  const db = spyDb('t_acme');
  assert.strictEqual(await lookupTenant('acme.ratiodev.in', undefined, db.fn), 't_acme');
  assert.strictEqual(db.calls(), 1);
});

test('S4 Tier-2: warm KV entry resolves even when Postgres is down (routing survives DB death)', async () => {
  const { kv } = fakeKV({ 'host:acme.ratiodev.in': JSON.stringify({ t: 't_acme' }) });
  const dbDown = async () => {
    throw new Error('ECONNREFUSED: postgres unreachable');
  };
  assert.strictEqual(await lookupTenant('acme.ratiodev.in', kv, dbDown), 't_acme');
});

test(
  'S4 D-R3: a hung DB query times out and does NOT populate KV (transient, not a cached 404)',
  { timeout: 1000 },
  async () => {
    const { kv, puts } = fakeKV();
    const hangs = () => new Promise<string | null>(() => {}); // never resolves
    await assert.rejects(lookupTenant('acme.ratiodev.in', kv, hangs, 10));
    assert.strictEqual(puts.length, 0, 'must not cache a negative on a DB timeout');
  }
);

test('second lookup after populate is served from KV (DB queried once)', async () => {
  const { kv } = fakeKV();
  const db = spyDb('t_acme');
  await lookupTenant('acme.ratiodev.in', kv, db.fn);
  assert.strictEqual(await lookupTenant('acme.ratiodev.in', kv, db.fn), 't_acme');
  assert.strictEqual(db.calls(), 1);
});
