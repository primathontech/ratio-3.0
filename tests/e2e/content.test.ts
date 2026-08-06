// Content CRUD (OFCE-362 slice 2): the owner edits page_config through the authed admin API
// (the legacy content-model editor, retained until the routes-table teardown). Real test DB, no
// mocks. Storefront rendering is the page builder's job now — covered by the page-builder tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../apps/admin-api/src/app';
import { pool } from '@ratio/data-db';

const OWNER = 'user_owner';
const OTHER = 'user_other';
const TOKENS: Record<string, string> = { 'tok-owner': OWNER, 'tok-other': OTHER };
const admin = createApp(async (t) => (TOKENS[t] ? { userId: TOKENS[t] } : null));

const ID = 't_content';
const owner = { authorization: 'Bearer tok-owner' };
const other = { authorization: 'Bearer tok-other' };

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return admin.fetch(
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
before(async () => {
  await cleanup();
  await call('POST', '/stores', owner, { id: ID, name: 'Content Co', host: 'content.localhost' });
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('owner lists pages (home route created at onboarding)', async () => {
  const r = await call('GET', `/stores/${ID}/pages`, owner);
  assert.strictEqual(r.status, 200);
  const { pages } = (await r.json()) as { pages: { path: string }[] };
  assert.ok(pages.some((p) => p.path === '/'));
});

test('a non-member cannot read or write content (403)', async () => {
  assert.strictEqual((await call('GET', `/stores/${ID}/pages`, other)).status, 403);
  const w = await call('PUT', `/stores/${ID}/page`, other, {
    path: '/x',
    pageConfig: { sections: [] },
  });
  assert.strictEqual(w.status, 403);
});

test('PUT rejects a bad path and a non-object pageConfig (400)', async () => {
  assert.strictEqual(
    (await call('PUT', `/stores/${ID}/page`, owner, { path: 'no-slash', pageConfig: {} })).status,
    400
  );
  assert.strictEqual(
    (await call('PUT', `/stores/${ID}/page`, owner, { path: '/ok', pageConfig: 'nope' })).status,
    400
  );
});

test('owner writes a page and can read it back', async () => {
  const cfg = { sections: [{ kind: 'hero', heading: 'Freshly Edited' }] };
  const w = await call('PUT', `/stores/${ID}/page`, owner, {
    path: '/promo',
    pageType: 'landing',
    pageConfig: cfg,
  });
  assert.strictEqual(w.status, 200);
  const g = await call('GET', `/stores/${ID}/page?path=/promo`, owner);
  assert.strictEqual(g.status, 200);
  const body = (await g.json()) as { pageType: string; pageConfig: typeof cfg };
  assert.strictEqual(body.pageType, 'landing');
  assert.strictEqual(body.pageConfig.sections[0].heading, 'Freshly Edited');
});

// The legacy content-model edit→render tests were removed with the legacy renderer. The
// page-builder authoring→storefront-render invariant is covered by page-builder-authoring.test.ts
// (admin publish) + page-builder-origin.test.ts (origin serves the published PageDoc).
