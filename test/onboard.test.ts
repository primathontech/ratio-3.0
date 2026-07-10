// Onboarding = provisioning: a new store is just rows. Real test DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { onboardStore } from '../packages/provisioning/index';
import { forTenant } from '../packages/repo/index';
import { app } from '../apps/origin/index';
import { pool } from '../packages/shared/db';

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const ID = 't_onb';
const HOST = 'onb.localhost';

async function cleanup() {
  await pool.query('DELETE FROM routes WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [ID]);
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
