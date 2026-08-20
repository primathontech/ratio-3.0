// Origin contract tests — in-process via app.fetch() (no server, real test DB). Provisions its own
// store (no reliance on shared seed rows) and cleans it up after.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { app, edgeAuthOk } from '../index';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';

const SECRET = resolveEdgeSecret(process.env);
const call = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request('http://origin' + path, { headers }));
const edge = (extra: Record<string, string> = {}) => ({ 'x-edge-auth': SECRET, ...extra });

const ACME = 't_origin_acme';
const HOME_DOC =
  '{"path":"/","title":"Home","sections":[{"id":"hero","type":"hero","data":{"hero":{"heading":"Acme","sub":"Welcome"}}}]}';

before(async () => {
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1,'Acme') ON CONFLICT (id) DO NOTHING`,
    [ACME]
  );
  await pool.query(
    `INSERT INTO pages (tenant_id, path, live_doc, revision) VALUES ($1,'/',$2::jsonb,1)
     ON CONFLICT (tenant_id, path) DO NOTHING`,
    [ACME, HOME_DOC]
  );
});
after(async () => {
  await pool.query('DELETE FROM pages WHERE tenant_id=$1', [ACME]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ACME]);
  await pool.end();
});

test('edgeAuthOk matches only the exact secret, constant-time (L-1)', () => {
  assert.strictEqual(edgeAuthOk('s3cret', 's3cret'), true);
  assert.strictEqual(edgeAuthOk('wrong!', 's3cret'), false);
  assert.strictEqual(edgeAuthOk('s3cre', 's3cret'), false); // length mismatch
  assert.strictEqual(edgeAuthOk(undefined, 's3cret'), false);
});

test('origin is private: no edge auth -> 403', async () => {
  const res = await call('/', { 'x-ratio-tenant': 't_acme' });
  assert.strictEqual(res.status, 403);
});

test('renders a tenant home with tenant + cache + surrogate headers', async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': ACME }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-tenant'), ACME);
  assert.strictEqual(res.headers.get('x-cache'), 'long');
  // page-builder surrogate keys: tenantTag is `t.<id>` (a page tag `p.<id>.<hash>` also rides along).
  assert.match(res.headers.get('x-surrogate-keys') || '', new RegExp(`(^| )t\\.${ACME}( |$)`));
  assert.match(await res.text(), /Acme/);
});

test('reserved path -> no-store system handler', async () => {
  // /cart redirects to open the side-cart drawer (below); /checkout + /account stay app-owned stubs.
  const res = await call('/checkout', edge({ 'x-ratio-tenant': 't_acme' }));
  assert.strictEqual(res.headers.get('x-handler'), 'reserved');
  assert.strictEqual(res.headers.get('x-cache'), 'no-store');
});

test('GET /cart: no cart page — bounce back (the side-cart widget owns the drawer)', async () => {
  const res = await call(
    '/cart',
    edge({ 'x-ratio-tenant': ACME, referer: 'http://origin/collections/all' })
  );
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('x-handler'), 'cart-open');
  assert.strictEqual(res.headers.get('location'), '/collections/all'); // back where the shopper was
  assert.strictEqual(res.headers.get('x-cache'), 'no-store');
});

test('GET /cart with no referer bounces to home', async () => {
  const res = await call('/cart', edge({ 'x-ratio-tenant': ACME }));
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/');
});

test('GET /cart referred from a cart route bounces to home, not into a redirect loop', async () => {
  const res = await call('/cart', edge({ 'x-ratio-tenant': ACME, referer: 'http://origin/cart' }));
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/'); // not '/cart' → no loop
});

test('POST /cart/add: mutate then bounce back + flag the drawer (no cart page)', async () => {
  const res = await app.fetch(
    new Request('http://origin/cart/add', {
      method: 'POST',
      headers: {
        ...edge({ 'x-ratio-tenant': ACME, referer: 'http://origin/products/x' }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'handle=some-handle',
    })
  );
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('x-handler'), 'cart-add');
  assert.strictEqual(res.headers.get('location'), '/products/x');
});

test('tenant isolation: acme cannot render betas /about route (404)', async () => {
  const res = await call('/about', edge({ 'x-ratio-tenant': ACME }));
  assert.strictEqual(res.status, 404);
});

test('unknown tenant -> 404 no-store', async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': 't_nope' }));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.headers.get('x-cache'), 'no-store');
});

test('a suspended tenant is not served (OFCE-410)', async () => {
  await pool.query(
    `INSERT INTO tenants (id, name, status, theme) VALUES ('t_susp','Susp','suspended','{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET status='suspended'`
  );
  try {
    const res = await call('/', edge({ 'x-ratio-tenant': 't_susp' }));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get('x-cache'), 'no-store');
  } finally {
    await pool.query("DELETE FROM tenants WHERE id='t_susp'");
  }
});

test('/robots.txt allows crawling, blocks transactional routes, links the sitemap (OFCE-718)', async () => {
  const res = await call('/robots.txt', edge({ 'x-ratio-tenant': ACME }));
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const body = await res.text();
  assert.match(body, /User-agent: \*/);
  assert.match(body, /Disallow: \/cart/);
  assert.match(body, /Sitemap: http:\/\/origin\/sitemap\.xml/);
});

test('/sitemap.xml returns a valid urlset including home (OFCE-718)', async () => {
  const res = await call('/sitemap.xml', edge({ 'x-ratio-tenant': ACME }));
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/xml/);
  const body = await res.text();
  assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(body, /<loc>http:\/\/origin\/<\/loc>/);
});

test('robots/sitemap require a resolved tenant (unknown -> 404)', async () => {
  const res = await call('/robots.txt', edge({ 'x-ratio-tenant': 't_nope_seo' }));
  assert.strictEqual(res.status, 404);
});
