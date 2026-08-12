// metafields (ADR-017 D4): a Shopify-style typed key-value store that lets apps and AI attach custom
// data to ANY resource without a migration. The schema's whole job is the identity key — exactly one
// row per (tenant, owner, namespace, key), isolated across tenants and across app namespaces. Real
// DB, no mocks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '@ratio/data-db';

const T1 = 't_mf_a';
const T2 = 't_mf_b';

const cleanup = () => pool.query('DELETE FROM metafields WHERE tenant_id = ANY($1)', [[T1, T2]]);

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

const upsert = (
  tenant: string,
  ownerType: string,
  ownerId: string,
  ns: string,
  key: string,
  type: string,
  value: unknown
) =>
  pool.query(
    `INSERT INTO metafields (tenant_id, owner_type, owner_id, namespace, key, type, value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, owner_type, owner_id, namespace, key)
     DO UPDATE SET type = EXCLUDED.type, value = EXCLUDED.value, updated_at = now()`,
    [tenant, ownerType, ownerId, ns, key, type, JSON.stringify(value)]
  );

test('one row per (tenant, owner, namespace, key) — re-upsert updates in place', async () => {
  await upsert(T1, 'product', 'p1', 'reviews', 'avg_rating', 'number', 4.2);
  await upsert(T1, 'product', 'p1', 'reviews', 'avg_rating', 'number', 4.8);
  const { rows } = await pool.query(
    `SELECT value FROM metafields
      WHERE tenant_id = $1 AND owner_type = 'product' AND owner_id = 'p1'
        AND namespace = 'reviews' AND key = 'avg_rating'`,
    [T1]
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].value), 4.8);
});

test('namespace isolates two apps writing the same key on the same owner', async () => {
  await upsert(T1, 'product', 'p1', 'reviews', 'count', 'number', 10);
  await upsert(T1, 'product', 'p1', 'loyalty', 'count', 'number', 99);
  const { rows } = await pool.query(
    `SELECT namespace FROM metafields
      WHERE tenant_id = $1 AND owner_id = 'p1' AND key = 'count' ORDER BY namespace`,
    [T1]
  );
  assert.deepEqual(
    rows.map((r) => r.namespace),
    ['loyalty', 'reviews']
  );
});

test('the same key under two tenants are independent rows (tenant-scoped)', async () => {
  await upsert(T1, 'tenant', T1, 'settings', 'theme_mode', 'string', 'dark');
  await upsert(T2, 'tenant', T2, 'settings', 'theme_mode', 'string', 'light');
  const a = await pool.query(
    `SELECT value FROM metafields WHERE tenant_id = $1 AND key = 'theme_mode'`,
    [T1]
  );
  const b = await pool.query(
    `SELECT value FROM metafields WHERE tenant_id = $1 AND key = 'theme_mode'`,
    [T2]
  );
  assert.equal(a.rows[0].value, 'dark');
  assert.equal(b.rows[0].value, 'light');
});
