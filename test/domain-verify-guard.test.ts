// Security-review guard for the S2/KV write-through (H1). markDomainVerified must REPORT
// whether it actually flipped `verified` for THIS tenant, so the edge-KV write-through only
// publishes a genuinely verified mapping. The dangerous case: a tenant that reclaimed the row
// but is NOT its connector — markDomainVerified must no-op AND return false, or the write-through
// would route the host to a tenant Postgres never verified (cross-tenant domain hijack).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { markDomainVerified } from '../packages/provisioning/index';
import { pool } from '../packages/shared/db';

const TA = 't_dvg_a';
const TB = 't_dvg_b';
const HOST = 'dvg.example.com';

async function cleanup() {
  await pool.query('DELETE FROM domains WHERE host = $1', [HOST]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[TA, TB]]);
}
before(async () => {
  await cleanup();
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1,'A'),($2,'B')", [TA, TB]);
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('returns true and flips verified when the caller IS the connector', async () => {
  await pool.query(
    'INSERT INTO domains (host, tenant_id, verified, connected_by) VALUES ($1,$2,false,$2)',
    [HOST, TA]
  );
  assert.strictEqual(await markDomainVerified(TA, HOST), true);
  const { rows } = await pool.query<{ verified: boolean }>(
    'SELECT verified FROM domains WHERE host = $1',
    [HOST]
  );
  assert.strictEqual(rows[0].verified, true);
  await pool.query('DELETE FROM domains WHERE host = $1', [HOST]);
});

test('returns false and does NOT verify when caller reclaimed the row but is not the connector (H1)', async () => {
  // B holds the row; A is the connector — B never ran its own DV. The write-through MUST NOT fire.
  await pool.query(
    'INSERT INTO domains (host, tenant_id, verified, connected_by) VALUES ($1,$2,false,$3)',
    [HOST, TB, TA]
  );
  assert.strictEqual(await markDomainVerified(TB, HOST), false);
  const { rows } = await pool.query<{ verified: boolean }>(
    'SELECT verified FROM domains WHERE host = $1',
    [HOST]
  );
  assert.strictEqual(rows[0].verified, false);
});
