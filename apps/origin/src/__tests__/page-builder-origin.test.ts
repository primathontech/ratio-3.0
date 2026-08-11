// Slice-1 walking skeleton, END TO END: save a Rich Text draft, publish it, and prove the
// ORIGIN serves the composed HTML for that path (flag-gated), tagged with exactly what publish
// purges. In-process via app.fetch(), real Postgres. Only the external purge service is faked.
// The page builder is the origin's storefront renderer (no flag).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, ISLANDS_URL, islandRegistry } from '../index';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { PgPageStore } from '@ratio/builder-core';
import { PageBuilder, type PurgeLike } from '@ratio/builder-core';
import { defaultRegistry } from '@ratio/builder-registry';
import { pageTag } from '@ratio/builder-core';

const SECRET = resolveEdgeSecret(process.env);
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
        type: 'COLLECTION_BY_HANDLES',
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

  // product template is DATA-BACKED: a PDP section bound to the route's product — fills BOTH the
  // product and price bindings.
  await b.saveDraft(T, {
    path: '/products/:handle',
    title: 'Product',
    dataSources: { main: { type: 'PRODUCT', params: { handle: '{{params.handle}}' } } },
    sections: [
      { id: 'h', type: 'heading', data: { heading: { text: 'Product page' } } },
      { id: 'p', type: 'product', dataSourceKey: 'main', data: {} },
    ],
  });
  await b.publish(T, '/products/:handle');

  // self-keyed static page
  await b.saveDraft(T, {
    path: '/pages/about-us',
    title: 'About us page',
    sections: [{ id: 'h', type: 'heading', data: { heading: { text: 'About us page' } } }],
  });
  await b.publish(T, '/pages/about-us');
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

test('a path with no published PageDoc is a 404 (page builder is the sole renderer)', async () => {
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

test('data binding: the product PDP fills BOTH product and price bindings from a PRODUCT source', async () => {
  const res = await call('/products/air-max-90', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Sample: air-max-90/, 'product.title injected into the PDP');
  assert.ok(
    (res.headers.get('x-surrogate-keys') || '').includes('prod:air-max-90'),
    'product tag for purge'
  );
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

// ── Islands runtime delivery: the shell references /assets/islands.<hash>.js only for island
// pages, the origin serves that runtime (immutable), and /api/island/:name hydrates per-request.

test('islands: the versioned runtime is served as executable JS with an immutable cache', async () => {
  const res = await call(ISLANDS_URL, edge());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  assert.match(res.headers.get('cache-control') || '', /immutable/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const js = await res.text();
  assert.match(js, /data-island/, 'this is the hydration runtime');
});

test('islands: an unknown /assets path is a 404 (not the HTML 404 page that broke MIME checks)', async () => {
  const res = await call('/assets/islands.deadbeef.js', edge());
  assert.equal(res.status, 404);
});

test('islands: /api/island/:name reaches the registry, is no-store, and is NOT swallowed as reserved', async () => {
  islandRegistry.register('cart-count', async ({ tenantId, userId }) => ({
    html: `<span data-t="${tenantId}">${userId ? 'you: 3' : 'cart: 0'}</span>`,
  }));
  const res = await call('/api/island/cart-count?sku=A1', edge({ 'x-ratio-tenant': T }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-handler'), 'island');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.match(await res.text(), new RegExp(`data-t="${T}"`), 'the tenant reaches the handler');

  const ghost = await call('/api/island/ghost', edge({ 'x-ratio-tenant': T }));
  assert.equal(ghost.status, 404);
});

test('islands: a storefront page with no island sections references no runtime (no 404)', async () => {
  const res = await call('/pb-home', edge({ 'x-ratio-tenant': T }));
  assert.ok(!/\/assets\/islands/.test(await res.text()), 'no dead islands.js reference');
});
