// Onboarding = provisioning: a new store is just rows. Real test DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { onboardStore } from '@ratio/provisioning';
import { forTenant } from '@ratio/repo';
import { app } from '../../services/origin/index';
import { pool } from '@ratio/shared/db';

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const ID = 't_onb';
const HOST = 'onb.localhost';

async function cleanup() {
  await pool.query('DELETE FROM routes WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [ID]);
  // generated-id stores from the auto-id test (unknown ids). Capture them via their hosts, then
  // delete children (routes/domains) before the tenant row so the domains FK isn't violated.
  const { rows } = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM domains WHERE host LIKE 'autogen-%'"
  );
  const ids = rows.map((r) => r.tenant_id);
  if (ids.length) {
    await pool.query('DELETE FROM routes WHERE tenant_id = ANY($1)', [ids]);
    await pool.query("DELETE FROM domains WHERE host LIKE 'autogen-%'");
    await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [ids]);
  }
}
before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('onboardStore creates tenant + domain + home route', async () => {
  await onboardStore({ id: ID, name: 'Onb', host: HOST, color: '#123456' });
  const tenant = await forTenant(ID).getTenant();
  assert.strictEqual(tenant!.name, 'Onb');
  const { rows } = await pool.query('SELECT tenant_id FROM domains WHERE host = $1', [HOST]);
  assert.strictEqual(rows[0].tenant_id, ID);
  const home = await forTenant(ID).getRoute('/');
  assert.strictEqual(home!.page_type, 'home');
});

test('the onboarded store renders its home via the origin', async () => {
  await onboardStore({ id: ID, name: 'Onb', host: HOST });
  const res = await app.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': ID } })
  );
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Onb/);
});

test('onboardStore is idempotent (re-onboard updates, no dup error)', async () => {
  await onboardStore({ id: ID, name: 'Onb', host: HOST, color: '#111' });
  await onboardStore({ id: ID, name: 'Onb Renamed', host: HOST, color: '#222' });
  const tenant = await forTenant(ID).getTenant();
  assert.strictEqual(tenant!.name, 'Onb Renamed');
});

test('onboardStore rejects incomplete input (no half-provisioned store)', async () => {
  await assert.rejects(() => onboardStore({ id: ID, name: 'x' })); // missing host
});

test('onboardStore persists merchantId to tenants.commerce (data-layer)', async () => {
  await onboardStore({ id: ID, name: 'Onb', host: HOST, merchantId: 'gk_persist' });
  assert.deepStrictEqual((await forTenant(ID).getTenant())!.commerce, { merchantId: 'gk_persist' });
});

test('re-onboard without merchantId preserves existing commerce (COALESCE)', async () => {
  await onboardStore({ id: ID, name: 'Onb', host: HOST, merchantId: 'gk_keep' });
  await onboardStore({ id: ID, name: 'Onb', host: HOST }); // no merchantId
  assert.deepStrictEqual((await forTenant(ID).getTenant())!.commerce, { merchantId: 'gk_keep' });
});

test('generates a unique t_<slug>_<hex> id when none is supplied, and never collides', async () => {
  // Same name twice → same slug seed, but the random suffix + PK check keep the ids distinct.
  const a = await onboardStore({ name: 'Auto Gen Shop', host: 'autogen-a.localhost' });
  const b = await onboardStore({ name: 'Auto Gen Shop', host: 'autogen-b.localhost' });
  assert.match(a.id, /^t_auto-gen-shop_[0-9a-f]{8}$/, 'readable slug + 8 hex suffix');
  assert.notStrictEqual(a.id, b.id, 'two stores never share an id');
  assert.ok(await forTenant(a.id).getTenant(), 'the generated store exists');
  assert.ok(await forTenant(b.id).getTenant());
});
