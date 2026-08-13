// OFCE-601 origin read path, END TO END: publish a bundle theme (ThemeStore → S3/MinIO), then prove
// the ORIGIN serves it — the compiled bundle's Liquid section rendered through the worker-thread
// isolate, in a real document shell, and a store with no bundle theme still falls through to the
// legacy page store. In-process via app.fetch(), real Postgres + MinIO. Gated on BUNDLE_S3_ENDPOINT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore } from '@ratio/builder-core';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { app } from '../index';

const SECRET = resolveEdgeSecret(process.env);
const endpoint = process.env.BUNDLE_S3_ENDPOINT;
const bucket = process.env.BUNDLE_S3_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.BUNDLE_S3_KEY ?? 'poc',
  secretAccessKey: process.env.BUNDLE_S3_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set BUNDLE_S3_ENDPOINT (MinIO) + a migrated DATABASE_URL';

const T = 'themebundle_o1';
const THEME = 'themebundle_o1_main';
const T2 = 'themebundle_o2';
const T3 = 'themebundle_o3';
const THEME3 = 'themebundle_o3_main';
const T4 = 'themebundle_o4';
const THEME4 = 'themebundle_o4_main';
const T5 = 'themebundle_o5';
const THEME5 = 'themebundle_o5_main';
const edge = (extra: Record<string, string> = {}) => ({ 'x-edge-auth': SECRET, ...extra });
const call = (path: string, headers: Record<string, string>) =>
  app.fetch(new Request('http://origin' + path, { headers }));

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  for (const id of [T, T2, T3, T4, T5]) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
  for (const id of [THEME, THEME3, THEME4, THEME5])
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Bundle Store', 'active')", [
    T,
  ]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'No Bundle', 'active')", [
    T2,
  ]);
  await pool.query(
    "INSERT INTO tenants (id, name, status) VALUES ($1, 'Broken Bundle', 'active')",
    [T3]
  );
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Mixed Bundle', 'active')", [
    T4,
  ]);
  await pool.query(
    "INSERT INTO tenants (id, name, status) VALUES ($1, 'Routed Bundle', 'active')",
    [T5]
  );

  const store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(T, THEME);
  await store.saveDraft(
    { themeId: THEME },
    {
      'sections/hero.liquid': '<section class="hero"><h1>{{ heading }}</h1></section>',
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Welcome to bundles' } }],
      }),
    }
  );
  await store.publish({ themeId: THEME }, { compile: (s) => s });

  // A live bundle whose template is malformed JSON — the render must throw and DEGRADE to legacy.
  await store.ensureTheme(T3, THEME3);
  await store.saveDraft({ themeId: THEME3 }, { 'templates/index.json': 'NOT JSON' });
  await store.publish({ themeId: THEME3 }, { compile: (s) => s });

  // A bundle mixing a PLATFORM section (heading — first-party code, no Liquid in the bundle) and a
  // THEME section (promo — Liquid in the bundle).
  await store.ensureTheme(T4, THEME4);
  await store.saveDraft(
    { themeId: THEME4 },
    {
      'sections/promo.liquid': '<p class="promo">{{ msg }}</p>',
      'templates/index.json': JSON.stringify({
        sections: [
          { type: 'heading', data: { heading: { text: 'Featured' } } },
          { type: 'promo', data: { msg: 'Hi there' } },
        ],
      }),
    }
  );
  await store.publish({ themeId: THEME4 }, { compile: (s) => s });

  // Shared templates by page type — /collections/:handle → collection.json, /products/:handle →
  // product.json (Shopify-shaped), so one template serves every collection/product URL.
  await store.ensureTheme(T5, THEME5);
  await store.saveDraft(
    { themeId: THEME5 },
    {
      'sections/collmark.liquid': '<div class="coll">Collection template</div>',
      'sections/prodmark.liquid': '<div class="prod">Product template</div>',
      'templates/collection.json': JSON.stringify({ sections: [{ type: 'collmark', data: {} }] }),
      'templates/product.json': JSON.stringify({ sections: [{ type: 'prodmark', data: {} }] }),
    }
  );
  await store.publish({ themeId: THEME5 }, { compile: (s) => s });
});

after(async () => {
  if (skip) return;
  for (const id of [THEME, THEME3, THEME4, THEME5])
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  for (const id of [T, T2, T3, T4, T5]) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
});

test(
  'origin renders a published bundle theme — theme-bundle handler, Liquid via isolate',
  {
    skip,
  },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': T }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    assert.equal(res.headers.get('x-theme-version'), '1');
    const body = await res.text();
    assert.match(body, /^<!doctype html>/);
    assert.match(
      body,
      /<h1>Welcome to bundles<\/h1>/,
      'the section Liquid rendered into the shell'
    );
  }
);

test(
  'a store with no bundle theme falls through to the legacy path (no regression)',
  {
    skip,
  },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': T2 }));
    // No live_theme_id → the bundle gate is off → the legacy page store handles it (404, no page).
    assert.notEqual(res.headers.get('x-handler'), 'theme-bundle');
  }
);

test('a broken bundle degrades to the legacy path, not a 500', { skip }, async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': T3 }));
  // The render throws (malformed template JSON) → caught → falls through to legacy (404, no page).
  assert.notEqual(res.status, 500);
  assert.notEqual(res.headers.get('x-handler'), 'theme-bundle');
});

test(
  'renders a page mixing a platform (code) section and a theme (Liquid) section',
  {
    skip,
  },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': T4 }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    const body = await res.text();
    assert.match(body, /<h2 class="heading">Featured<\/h2>/); // platform section, rendered from code
    assert.match(body, /<p class="promo">Hi there<\/p>/); // theme section, rendered from bundle Liquid
  }
);

test(
  'shared-template routing: a collection and a product URL render their bundle templates',
  {
    skip,
  },
  async () => {
    const coll = await call('/collections/summer', edge({ 'x-ratio-tenant': T5 }));
    assert.equal(coll.headers.get('x-handler'), 'theme-bundle');
    assert.match(await coll.text(), /Collection template/); // one collection.json serves every handle

    const prod = await call('/products/air-max-90', edge({ 'x-ratio-tenant': T5 }));
    assert.equal(prod.headers.get('x-handler'), 'theme-bundle');
    assert.match(await prod.text(), /Product template/); // one product.json serves every handle
  }
);
