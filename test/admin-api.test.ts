// Control-plane API: authenticated onboarding/store management (ADR-014).
// The admin UI + the AI agent both call this. In-process via app.fetch(), real test DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { app } from '../services/admin-api/app';
import { forTenant } from '../packages/repo/index';
import { pool } from '../packages/shared/db';

const TOKEN = 'test-token';
process.env.CONTROL_PLANE_TOKEN = TOKEN;
const ID = 't_cp';
const auth = { authorization: `Bearer ${TOKEN}` };

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

async function cleanup() {
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('GET /health is public', async () => {
  const r = await call('GET', '/health');
  assert.strictEqual(r.status, 200);
});

test('POST /stores requires auth (401 without token)', async () => {
  const r = await call('POST', '/stores', {}, { id: ID, name: 'CP', host: 'cp.localhost' });
  assert.strictEqual(r.status, 401);
});

test('POST /stores onboards a store (authed)', async () => {
  const r = await call('POST', '/stores', auth, {
    id: ID,
    name: 'CP',
    host: 'cp.localhost',
    color: '#123456',
  });
  assert.strictEqual(r.status, 201);
  const t = await forTenant(ID).getTenant();
  assert.strictEqual(t!.name, 'CP');
});

test('GET /stores/:id returns the store (authed)', async () => {
  const r = await call('GET', `/stores/${ID}`, auth);
  assert.strictEqual(r.status, 200);
  const body = (await r.json()) as { id: string };
  assert.strictEqual(body.id, ID);
});

test('DELETE /stores/:id removes it (authed, provable)', async () => {
  const r = await call('DELETE', `/stores/${ID}`, auth);
  assert.strictEqual(r.status, 200);
  const body = (await r.json()) as { residual: number };
  assert.strictEqual(body.residual, 0);
  assert.strictEqual(await forTenant(ID).getTenant(), null);
});
