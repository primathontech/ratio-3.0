// H-1: a merchant must not be able to self-serve a reserved/apex/multi-label platform
// subdomain (e.g. login.ratiodev.in) — that would serve attacker content on Ratio's own
// trusted domain. Merchants keep any single non-reserved *.ratiodev.in.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-platform-host-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp, platformSubdomainAllowed } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

test('platformSubdomainAllowed: reserved/apex/multi-label blocked, normal + custom allowed', () => {
  // Non-admin
  assert.strictEqual(platformSubdomainAllowed('login.ratiodev.in', false), false);
  assert.strictEqual(platformSubdomainAllowed('www.ratiodev.in', false), false);
  assert.strictEqual(platformSubdomainAllowed('admin.ratiodev.in', false), false);
  assert.strictEqual(platformSubdomainAllowed('ratiodev.in', false), false); // apex
  assert.strictEqual(platformSubdomainAllowed('a.b.ratiodev.in', false), false); // multi-label
  assert.strictEqual(platformSubdomainAllowed('acme.ratiodev.in', false), true); // normal merchant
  assert.strictEqual(platformSubdomainAllowed('shop.example.com', false), true); // custom domain
  // Platform admin (ops) may assign any platform host
  assert.strictEqual(platformSubdomainAllowed('login.ratiodev.in', true), true);
  assert.strictEqual(platformSubdomainAllowed('ratiodev.in', true), true);
});

const ALICE = 'user_ph_alice';
const humans: Verifier = async (t) => (t === 'tok-alice' ? { userId: ALICE } : null);
const app = createApp(composeVerifiers(agentVerifier, humans));
const call = (body: unknown) =>
  app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-alice' },
      body: JSON.stringify(body),
    })
  );

before(() => pool.query("DELETE FROM tenants WHERE id IN ('t_ph_squat','t_ph_ok')"));
after(async () => {
  await pool.query('DELETE FROM memberships WHERE tenant_id IN ($1,$2)', ['t_ph_squat', 't_ph_ok']);
  await pool.query('DELETE FROM domains WHERE tenant_id IN ($1,$2)', ['t_ph_squat', 't_ph_ok']);
  await pool.query('DELETE FROM routes WHERE tenant_id IN ($1,$2)', ['t_ph_squat', 't_ph_ok']);
  await pool.query("DELETE FROM tenants WHERE id IN ('t_ph_squat','t_ph_ok')");
  await pool.end();
});

test('POST /stores rejects a reserved platform subdomain (403) and creates nothing', async () => {
  const res = await call({ id: 't_ph_squat', name: 'Squat', host: 'login.ratiodev.in' });
  assert.strictEqual(res.status, 403);
  const { rows } = await pool.query('SELECT id FROM tenants WHERE id=$1', ['t_ph_squat']);
  assert.strictEqual(rows.length, 0);
});

test('POST /stores still allows a normal merchant *.ratiodev.in subdomain', async () => {
  const res = await call({ id: 't_ph_ok', name: 'OK', host: 'phok.ratiodev.in' });
  assert.strictEqual(res.status, 201);
});

test('POST /stores rejects a malformed host (400) and creates nothing (H1)', async () => {
  for (const host of ['notadomain', 'has space.com', 'javascript:alert(1)']) {
    const res = await call({ id: 't_ph_bad', name: 'Bad', host });
    assert.strictEqual(res.status, 400, `host ${host} should be rejected`);
  }
  const { rows } = await pool.query('SELECT id FROM tenants WHERE id=$1', ['t_ph_bad']);
  assert.strictEqual(rows.length, 0);
});
