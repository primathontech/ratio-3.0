// Bundle-theme authoring endpoints (OFCE-601, base ⊕ overrides): draft save/preview, publish,
// rollback. In-process via app.fetch(), real test DB, injected verifier. The store logic (compose,
// freeze, publish/rollback) is unit-tested in builder-core against MinIO; this covers the HTTP
// wrapper — routing, membership/owner authz, the derived one-theme-per-store id, and the 503 gate.
// S3 is an external service, so the ObjectStore is faked in-memory here (the DB is real).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../app';
import { ThemeStore } from '@ratio/builder-core';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_tb'; // owner
const BOB = 'user_bob_tb'; // no membership
const CAROL = 'user_carol_tb'; // member (editor), not owner
const verify = async (token: string) =>
  token === 'tok-alice'
    ? { userId: ALICE }
    : token === 'tok-bob'
      ? { userId: BOB }
      : token === 'tok-carol'
        ? { userId: CAROL }
        : null;

// An in-memory ObjectStore — the bundle bytes live here instead of S3/MinIO.
function memStore(): ObjectStore {
  const mem = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => {
      mem.set(k, b as Uint8Array);
      return { etag: 'x' };
    },
    get: async (k) => mem.get(k) ?? null,
    head: async (k) => (mem.has(k) ? { etag: 'x' } : null),
    delete: async (k) => {
      mem.delete(k);
    },
  };
}

const app = createApp(verify, { bundleThemes: new ThemeStore(memStore()) });
// A second app with NO bundle store wired — exercises the 503 gate.
const appNoStore = createApp(verify, { bundleThemes: null });

const ID = 't_theme_bundle';
const MAIN = `${ID}-main`;
const alice = { authorization: 'Bearer tok-alice' };
const bob = { authorization: 'Bearer tok-bob' };
const carol = { authorization: 'Bearer tok-carol' };

const call = (
  a: typeof app,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
) =>
  a.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  );

async function cleanup() {
  await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [MAIN]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [ID]);
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [ID]
  );
  await pool.query('DELETE FROM theme WHERE id = $1', [MAIN]);
  await pool.query('DELETE FROM memberships WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [ID]);
}

before(async () => {
  await cleanup();
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'ThemeBundle')`, [ID]);
  await pool.query(
    `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
    [ALICE, ID]
  );
  await pool.query(
    `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1, $2, 'editor')`,
    [CAROL, ID]
  );
});
beforeEach(async () => {
  await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [MAIN]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [ID]);
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [ID]
  );
  await pool.query('DELETE FROM theme WHERE id = $1', [MAIN]);
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('draft save then preview round-trips base ⊕ overrides for the derived theme', async () => {
  const save = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { 'index.liquid': 'HELLO', 'header.liquid': 'H' },
  });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(((await save.json()) as { ok: boolean }).ok, true);

  const view = await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice);
  assert.strictEqual(view.status, 200);
  assert.deepStrictEqual(((await view.json()) as { files: Record<string, string> }).files, {
    'index.liquid': 'HELLO',
    'header.liquid': 'H',
  });
});

test('owner publishes → 200 with version 1 and the tenant live pointer moves', async () => {
  await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { 'index.liquid': 'HELLO' },
  });
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(((await pub.json()) as { version: number }).version, 1);

  const { rows } = await pool.query<{ live_theme_id: string; live_theme_version: number }>(
    'SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1',
    [ID]
  );
  assert.strictEqual(rows[0].live_theme_id, MAIN);
  assert.strictEqual(rows[0].live_theme_version, 1);
});

test('a non-owner cannot save a draft (403) or publish (403)', async () => {
  const draft = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, bob, { files: {} });
  assert.strictEqual(draft.status, 403);
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, bob, {});
  assert.strictEqual(pub.status, 403);
});

test('owner rolls back to an earlier version → 200 and the pointer moves back', async () => {
  await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { 'a.liquid': 'v1' },
  });
  await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {}); // v1
  await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { 'a.liquid': 'v2' },
  });
  await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {}); // v2

  const rb = await call(app, 'POST', `/stores/${ID}/theme/bundle/rollback`, alice, { version: 1 });
  assert.strictEqual(rb.status, 200);

  const { rows } = await pool.query<{ live_theme_version: number }>(
    'SELECT live_theme_version FROM tenants WHERE id = $1',
    [ID]
  );
  assert.strictEqual(rows[0].live_theme_version, 1);
});

test('rollback to an unknown version → 404', async () => {
  await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { 'a.liquid': 'v1' },
  });
  await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {}); // v1
  const rb = await call(app, 'POST', `/stores/${ID}/theme/bundle/rollback`, alice, { version: 99 });
  assert.strictEqual(rb.status, 404);
});

test('a member (non-owner) can save/preview a draft but cannot publish or rollback', async () => {
  const save = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, carol, {
    files: { 'a.liquid': 'by-editor' },
  });
  assert.strictEqual(save.status, 200);
  const view = await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, carol);
  assert.strictEqual(view.status, 200);
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, carol, {});
  assert.strictEqual(pub.status, 403);
  const rb = await call(app, 'POST', `/stores/${ID}/theme/bundle/rollback`, carol, { version: 1 });
  assert.strictEqual(rb.status, 403);
});

test('publish with no saved draft → 400 (publish does not create the theme)', async () => {
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  assert.strictEqual(pub.status, 400);
});

test('every bundle endpoint is 503 when no object store is configured', async () => {
  const put = await call(appNoStore, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: {},
  });
  const get = await call(appNoStore, 'GET', `/stores/${ID}/theme/bundle/draft`, alice);
  const pub = await call(appNoStore, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  const rb = await call(appNoStore, 'POST', `/stores/${ID}/theme/bundle/rollback`, alice, {
    version: 1,
  });
  assert.strictEqual(put.status, 503);
  assert.strictEqual(get.status, 503);
  assert.strictEqual(pub.status, 503);
  assert.strictEqual(rb.status, 503);
});
