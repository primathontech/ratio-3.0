// Slice-1 walking skeleton, END TO END: save a Rich Text draft, publish it, and prove the
// ORIGIN serves the composed HTML for that path (flag-gated), tagged with exactly what publish
// purges. In-process via app.fetch(), real Postgres. Only the external purge service is faked.
// The page builder is the origin's storefront renderer (no flag).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../../services/origin/index';
import { pool } from '@ratio/shared/db';
import { PgPageStore } from '@ratio/page-builder-core/store-pg';
import { PageBuilder, type PurgeLike } from '@ratio/page-builder-core/store';
import { defaultRegistry } from '@ratio/page-builder-registry/registry';
import { pageTag } from '@ratio/page-builder-core/tags';

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

  // collection template is DATA-BACKED: a productGrid bound to the route's collection via the
  // resolver ({{params.handle}} → the CMS). Uses the StubResolver in tests.
  await b.saveDraft(T, {
    path: '/collections/:handle',
    title: 'Collection',
    dataSources: {
      main: {
        type: 'collectionByHandles',
        params: { handles: ['{{params.handle}}'], productLimit: 4 },
      },
    },
    sections: [
      { id: 'h', type: 'heading', data: { heading: { text: 'Collection page' } } },
      {
        id: 'g',
        type: 'productGrid',
        dataSourceKey: 'main',
        data: { grid: { heading: 'Products' } },
      },
    ],
  });
  await b.publish(T, '/collections/:handle');

  // remaining simple templates + a self-keyed static page
  for (const [key, text] of [
    ['/products/:handle', 'Product page'],
    ['/pages/about-us', 'About us page'],
  ] as const) {
    await b.saveDraft(T, {
      path: key,
      title: text,
      sections: [{ id: 'h', type: 'heading', data: { heading: { text } } }],
    });
    await b.publish(T, key);
  }
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

test('routing: a collection URL renders the one collection template + route metadata', async () => {
  const res = await call('/collections/summer', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-handler'), 'page-builder');
  assert.equal(res.headers.get('x-page-type'), 'collection');
  const keys = res.headers.get('x-surrogate-keys') || '';
  assert.ok(keys.includes(pageTag(T, '/collections/summer')), 'tagged by the concrete URL');
  assert.ok(
    keys.includes(pageTag(T, '/collections/:handle')),
    'tagged by the template (purge-all)'
  );
  assert.match(await res.text(), /Collection page/);
});

test('routing: flat + nested product URLs both render the one product template', async () => {
  for (const url of ['/products/air-max-90', '/collections/summer/products/air-max-90']) {
    const res = await call(url, edge({ 'x-ratio-tenant': T }));
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('x-page-type'), 'product', url);
    assert.match(await res.text(), /Product page/, url);
  }
});

test('data binding: the collection template renders resolved products + a col:<handle> tag', async () => {
  const res = await call('/collections/summer', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Sample product 1/, 'stub products injected into the grid');
  assert.ok(
    (res.headers.get('x-surrogate-keys') || '').includes('col:summer'),
    'tagged with the resolved collection so a CMS change can purge it'
  );
});

test('routing: /pages/:handle is a self-keyed static page (its own doc, page type, no template tag)', async () => {
  const res = await call('/pages/about-us', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-handler'), 'page-builder');
  assert.equal(res.headers.get('x-page-type'), 'page');
  const keys = res.headers.get('x-surrogate-keys') || '';
  assert.ok(keys.includes(pageTag(T, '/pages/about-us')), 'tagged by its own path');
  assert.match(await res.text(), /About us page/);
});
