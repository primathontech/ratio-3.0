// Slice-1 walking skeleton, END TO END: save a Rich Text draft, publish it, and prove the
// ORIGIN serves the composed HTML for that path (flag-gated), tagged with exactly what publish
// purges. In-process via app.fetch(), real Postgres. Only the external purge service is faked.
// Run: PAGE_BUILDER_ENABLED=true node --import tsx --test test/page-builder-origin.test.ts

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.PAGE_BUILDER_ENABLED = 'true';
import { app } from '../apps/origin/index';
import { pool } from '../packages/shared/db';
import { PgPageStore } from '../packages/page-builder/store-pg';
import { PageBuilder, type PurgeLike } from '../packages/page-builder/store';
import { defaultRegistry } from '../packages/section-registry/registry';
import { pageTag } from '../packages/page-builder/tags';

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const T = 'pbtest_o1';
const edge = (extra: Record<string, string> = {}) => ({ 'x-edge-auth': SECRET, ...extra });
const call = (path: string, headers: Record<string, string>) =>
  app.fetch(new Request('http://origin' + path, { headers }));

class NoopPurge implements PurgeLike {
  async invalidateByTags(): Promise<void> {}
}

before(async () => {
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, 'PB Test') ON CONFLICT (id) DO NOTHING",
    [T]
  );
  const b = new PageBuilder(new PgPageStore(), defaultRegistry(), new NoopPurge());
  await b.saveDraft(T, {
    path: '/pb-home',
    title: 'PB Home',
    sections: [
      {
        id: 'r1',
        type: 'richText',
        data: { rich: { html: '<p>hello <b>world</b></p><script>alert(1)</script>' } },
      },
    ],
  });
  await b.publish(T, '/pb-home');
});

after(async () => {
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM pages WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.end();
});

test('origin serves the published PageDoc — composed HTML, page-builder handler, cacheable + tagged', async () => {
  const res = await call('/pb-home', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-handler'), 'page-builder');
  assert.equal(res.headers.get('x-page-tier'), 'static');
  assert.equal(res.headers.get('x-cache'), 'long');
  assert.match(res.headers.get('cache-control') || '', /s-maxage=300/);
  assert.ok(
    (res.headers.get('x-surrogate-keys') || '').includes(pageTag(T, '/pb-home')),
    'tagged with exactly the tag publish() purges'
  );
  const body = await res.text();
  assert.match(body, /<title>PB Home<\/title>/);
  assert.match(body, /hello <b>world<\/b>/, 'rich text rendered into the shell');
  assert.ok(!body.includes('<script>alert'), 'script vector sanitized at save, never served');
});

test('unpublished path falls through to the legacy route table (404 here)', async () => {
  const res = await call('/pb-missing', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-handler'), null, 'page-builder did not handle it');
});
