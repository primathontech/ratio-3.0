// Control-plane API auth (ADR-010/014): Clerk verifies identity, our memberships table
// authorizes per store. In-process via app.fetch(), real test DB. The verifier is
// injected (Clerk is an external service — mock the boundary, never the DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../services/admin-api/app';
import { getMembership } from '../services/admin-api/auth';
import { forTenant } from '../packages/repo/index';
import { pool } from '../packages/shared/db';

const ALICE = 'user_alice';
const BOB = 'user_bob';
const TOKENS: Record<string, string> = { 'tok-alice': ALICE, 'tok-bob': BOB };
// Injected verifier: a bearer token maps to a user id; anything else is anonymous.
const verify = async (token: string) => (TOKENS[token] ? { userId: TOKENS[token] } : null);
const app = createApp(verify);

const ID = 't_cp';
const alice = { authorization: 'Bearer tok-alice' };
const bob = { authorization: 'Bearer tok-bob' };

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
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
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

test('GET / is a public 200 (ECS load-balancer health check)', async () => {
  const r = await call('GET', '/');
  assert.strictEqual(r.status, 200);
});

test('CORS preflight passes the auth gate and returns the allow-origin header', async () => {
  const r = await app.fetch(
    new Request('http://cp/stores', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://admin.example',
        'access-control-request-method': 'POST',
      },
    })
  );
  assert.notStrictEqual(r.status, 401);
  assert.ok(r.headers.get('access-control-allow-origin'));
});

test('POST /stores without a session is 401', async () => {
  const r = await call('POST', '/stores', {}, { id: ID, name: 'CP', host: 'cp.localhost' });
  assert.strictEqual(r.status, 401);
});

test('a garbage token is 401 (deny-by-default)', async () => {
  const r = await call('GET', `/stores/${ID}`, { authorization: 'Bearer nope' });
  assert.strictEqual(r.status, 401);
});

test('POST /stores creates the store and makes the caller its owner', async () => {
  const r = await call('POST', '/stores', alice, {
    id: ID,
    name: 'CP',
    host: 'cp.localhost',
    color: '#123456',
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await forTenant(ID).getTenant())!.name, 'CP');
  assert.strictEqual((await getMembership(ALICE, ID))!.role, 'owner');
});

test('GET /stores lists only the caller’s own stores', async () => {
  const mine = await (await call('GET', '/stores', alice)).json();
  assert.ok((mine as { stores: { id: string }[] }).stores.some((s) => s.id === ID));
  const theirs = await (await call('GET', '/stores', bob)).json();
  assert.ok(!(theirs as { stores: { id: string }[] }).stores.some((s) => s.id === ID));
});

test('the owner can read the store', async () => {
  const r = await call('GET', `/stores/${ID}`, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(((await r.json()) as { id: string }).id, ID);
});

test('a different authenticated user is 403 (no membership)', async () => {
  const r = await call('GET', `/stores/${ID}`, bob);
  assert.strictEqual(r.status, 403);
});

test('a non-owner cannot delete the store', async () => {
  const r = await call('DELETE', `/stores/${ID}`, bob);
  assert.strictEqual(r.status, 403);
  assert.notStrictEqual(await forTenant(ID).getTenant(), null);
});

test('the owner deletes the store (provable) and the membership is gone', async () => {
  const r = await call('DELETE', `/stores/${ID}`, alice);
  assert.strictEqual(r.status, 200);
  const body = (await r.json()) as { residual: number; removed: { memberships: number } };
  assert.strictEqual(body.residual, 0);
  assert.strictEqual(body.removed.memberships, 1);
  assert.strictEqual(await forTenant(ID).getTenant(), null);
  assert.strictEqual(await getMembership(ALICE, ID), null);
});
