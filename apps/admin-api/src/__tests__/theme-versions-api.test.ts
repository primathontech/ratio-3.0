// Theme-versioning endpoints (ADR-013 §13): publish / rollback / history. In-process via
// app.fetch(), real test DB, injected verifier. The store logic is unit-tested in builder-core;
// this covers the HTTP wrapper — routing, owner authz, and the 409/error mapping.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../app';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_tv'; // owner
const BOB = 'user_bob_tv'; // no membership
const verify = async (token: string) =>
  token === 'tok-alice' ? { userId: ALICE } : token === 'tok-bob' ? { userId: BOB } : null;
const app = createApp(verify);

const ID = 't_theme_api';
const alice = { authorization: 'Bearer tok-alice' };
const bob = { authorization: 'Bearer tok-bob' };

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  );

async function cleanup() {
  for (const t of ['memberships', 'pages', 'theme_versions', 'page_purge_outbox', 'tenants'])
    await pool.query(`DELETE FROM ${t} WHERE ${t === 'tenants' ? 'id' : 'tenant_id'} = $1`, [ID]);
}

before(async () => {
  await cleanup();
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'ThemeApi')`, [ID]);
  await pool.query(
    `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
    [ALICE, ID]
  );
});
beforeEach(async () => {
  await pool.query('DELETE FROM pages WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM theme_versions WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [ID]);
  await pool.query('UPDATE tenants SET published_theme_version = NULL WHERE id = $1', [ID]);
  await pool.query(
    `INSERT INTO pages (tenant_id, path, live_doc, revision)
     VALUES ($1, '/', '{"path":"/","title":"Home","sections":[]}'::jsonb, 1)`,
    [ID]
  );
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('owner publishes the theme → 200 with a version, and history reflects it', async () => {
  const pub = await call('POST', `/stores/${ID}/theme/publish`, alice, { note: 'launch' });
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(((await pub.json()) as { version: number }).version, 1);

  const hist = await call('GET', `/stores/${ID}/theme/versions`, alice);
  const body = (await hist.json()) as { published: number; versions: { version: number }[] };
  assert.strictEqual(body.published, 1);
  assert.deepStrictEqual(
    body.versions.map((v) => v.version),
    [1]
  );
});

test('a non-owner cannot publish (403)', async () => {
  const r = await call('POST', `/stores/${ID}/theme/publish`, bob, {});
  assert.strictEqual(r.status, 403);
});

test('a stale expectedBase is a 409 (optimistic concurrency)', async () => {
  await call('POST', `/stores/${ID}/theme/publish`, alice, {}); // → v1, pointer = 1
  const conflict = await call('POST', `/stores/${ID}/theme/publish`, alice, { expectedBase: 0 });
  assert.strictEqual(conflict.status, 409);
});

test('owner rolls back to an earlier version → 200 and the pointer moves back', async () => {
  await call('POST', `/stores/${ID}/theme/publish`, alice, {}); // v1
  await pool.query(
    `UPDATE pages SET draft_doc = '{"path":"/","title":"Home v2","sections":[]}'::jsonb WHERE tenant_id = $1 AND path = '/'`,
    [ID]
  );
  await call('POST', `/stores/${ID}/theme/publish`, alice, { expectedBase: 1 }); // v2

  const rb = await call('POST', `/stores/${ID}/theme/rollback`, alice, { version: 1 });
  assert.strictEqual(rb.status, 200);

  const hist = await call('GET', `/stores/${ID}/theme/versions`, alice);
  assert.strictEqual(((await hist.json()) as { published: number }).published, 1);
});
