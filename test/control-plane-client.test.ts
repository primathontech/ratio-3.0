// ADR-016 Phase 1 (OFCE-401): the generated SDK is a real caller of the control-plane, and
// the OpenAPI contract is served. `fetch` is injected to route the SDK at the in-process app
// (no network), matching this repo's test style. Real test DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-sdk-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { RatioControlPlane, ControlPlaneError } from '@ratio/control-plane-client';
import { pool } from '../packages/shared/db';

const ALICE = 'user_alice_sdk';
const ID = 't_sdk';
const humanVerifier: Verifier = async (t) => (t === 'tok-alice' ? { userId: ALICE } : null);
const app = createApp(composeVerifiers(agentVerifier, humanVerifier));

// Route the SDK's fetch at the in-process app instead of the network.
const viaApp: typeof fetch = ((url: string | URL | Request, init?: RequestInit) =>
  app.fetch(new Request(url as string, init))) as typeof fetch;

const client = new RatioControlPlane({ baseUrl: 'http://cp', token: 'tok-alice', fetch: viaApp });

async function cleanup() {
  await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [ID]);
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

test('GET /openapi.json is public and describes the API', async () => {
  const r = await app.fetch(new Request('http://cp/openapi.json'));
  assert.strictEqual(r.status, 200);
  const doc = (await r.json()) as {
    openapi: string;
    info: { version: string };
    paths: Record<string, unknown>;
  };
  assert.strictEqual(doc.openapi, '3.1.0');
  assert.strictEqual(doc.info.version, '1.0.0');
  assert.ok(doc.paths['/stores'] && doc.paths['/stores/{id}/page']);
});

test('the SDK onboards, reads, and edits a store (real caller, in-process)', async () => {
  const created = await client.createStore({ id: ID, name: 'SDK Store', host: 'sdk.localhost' });
  assert.strictEqual(created.id, ID);

  const store = await client.getStore(ID);
  assert.strictEqual(store.id, ID);
  assert.strictEqual(store.name, 'SDK Store');

  const page = await client.putPage(ID, { path: '/', pageConfig: { type: 'root', children: [] } });
  assert.strictEqual(page.path, '/');

  const list = await client.listStores();
  assert.ok(list.stores.some((s) => s.id === ID));
});

test('the SDK mints an agent token and a second SDK client drives the API with it', async () => {
  const minted = await client.mintAgentToken(ID);
  assert.deepStrictEqual(minted.scope, [ID]);
  assert.ok(minted.token.startsWith('rat_'));

  const agentClient = new RatioControlPlane({
    baseUrl: 'http://cp',
    token: minted.token,
    fetch: viaApp,
  });
  const page = await agentClient.putPage(ID, {
    path: '/via-sdk-agent',
    pageConfig: { type: 'root', children: [] },
  });
  assert.strictEqual(page.path, '/via-sdk-agent');
});

test('the SDK reads the store audit trail', async () => {
  const { entries } = await client.listAudit(ID);
  assert.ok(Array.isArray(entries) && entries.length > 0);
  assert.ok(entries.some((e) => e.action === 'pages:write'));
});

test('an unauthenticated SDK call rejects with a typed 401 error', async () => {
  const anon = new RatioControlPlane({ baseUrl: 'http://cp', fetch: viaApp });
  await assert.rejects(
    () => anon.getStore(ID),
    (e: unknown) => e instanceof ControlPlaneError && e.status === 401
  );
});
