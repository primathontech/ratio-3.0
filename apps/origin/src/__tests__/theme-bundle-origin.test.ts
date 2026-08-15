// OFCE-601 origin read path, END TO END: publish a bundle theme (ThemeStore → S3/MinIO), then prove
// the ORIGIN serves it — the compiled bundle's Liquid section rendered through the worker-thread
// isolate, in a real document shell, and a store with no bundle theme still falls through to the
// legacy page store. In-process via app.fetch(), real Postgres + MinIO. Gated on BUNDLE_S3_ENDPOINT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, tenantTag, ensureDefaultBaseTheme } from '@ratio/builder-core';
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
const T6 = 'themebundle_o6';
const THEME6 = 'themebundle_o6_main';
const T7 = 'themebundle_o7';
const THEME7 = 'themebundle_o7_main';
const T8 = 'themebundle_o8';
const THEME8 = 'themebundle_o8_main';
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
  for (const id of [THEME, THEME3, THEME4, THEME5, THEME6, THEME7, THEME8])
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  for (const id of [T, T2, T3, T4, T5, T6, T7, T8])
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
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
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Data Bundle', 'active')", [
    T6,
  ]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Base Adopt', 'active')", [
    T7,
  ]);
  // A store whose theme sets its OWN brand tokens (config/tokens.json) while its tenant-level theme
  // carries a brand colour + container the theme leaves unset — proves theme-wins + tenant-fallback.
  await pool.query(
    "INSERT INTO tenants (id, name, status, theme) VALUES ($1, 'Token Store', 'active', $2)",
    [T8, JSON.stringify({ color: '#ff0000', container: 'wide' })]
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

  // A data-sourced home: the section binds to a collection, so the resolver's col:* tags must reach
  // x-surrogate-keys (data-driven purge — a collection change purges the pages showing it).
  await store.ensureTheme(T6, THEME6);
  await store.saveDraft(
    { themeId: THEME6 },
    {
      'sections/plist.liquid':
        '<ul>{% for p in products %}<li>{{ p.title | escape }}</li>{% endfor %}</ul>',
      'templates/index.json': JSON.stringify({
        dataSources: { main: { type: 'COLLECTION_BY_HANDLES', params: { handles: ['summer'] } } },
        sections: [{ type: 'plist', dataSourceKey: 'main', data: {} }],
      }),
    }
  );
  await store.publish({ themeId: THEME6 }, { compile: (s) => s });

  // A store that ADOPTS the shared Default base and overrides ONE section (its hero). The origin must
  // render the BASE's own sections (header, footer) alongside the merchant's OVERRIDE (hero) on a real
  // page — the OFCE-601 P0 acceptance: base + one merchant-edited Liquid section, end-to-end.
  const base = await ensureDefaultBaseTheme(store, { compile: (s) => s });
  await store.ensureTheme(T7, THEME7, 'Store', { themeId: base.themeId, version: base.version });
  await store.saveDraft(
    { themeId: THEME7 },
    { 'sections/hero.liquid': '<section class="mine"><h1>MERCHANT {{ heading }}</h1></section>' }
  );
  await store.publish({ themeId: THEME7 }, { compile: (s) => s });

  await store.ensureTheme(T8, THEME8);
  await store.saveDraft(
    { themeId: THEME8 },
    {
      'config/tokens.json': JSON.stringify({ radius: 'rounded' }),
      'sections/hero.liquid': '<section class="hero"><h1>{{ heading }}</h1></section>',
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Tokens' } }],
      }),
    }
  );
  await store.publish({ themeId: THEME8 }, { compile: (s) => s });
});

after(async () => {
  if (skip) return;
  // The shared library base (library-default / _library) is left in place — a persistent fixture.
  for (const id of [THEME, THEME3, THEME4, THEME5, THEME6, THEME7, THEME8])
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  for (const id of [T, T2, T3, T4, T5, T6, T7, T8])
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
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
    // Cacheable at the edge, tagged so a theme publish can purge the whole store.
    assert.equal(res.headers.get('x-cache'), 'long');
    assert.match(res.headers.get('cache-control') || '', /s-maxage=300/);
    assert.ok(
      (res.headers.get('x-surrogate-keys') || '').includes(tenantTag(T)),
      'tagged by the tenant tag (a theme publish purges every page of the store)'
    );
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

    // This bundle has no index.json → GET / has no matching template → falls through to legacy.
    const home = await call('/', edge({ 'x-ratio-tenant': T5 }));
    assert.notEqual(home.headers.get('x-handler'), 'theme-bundle');
  }
);

test(
  'per-theme tokens: the theme config/tokens.json drives the head, tenant theme fills the gaps',
  { skip },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': T8 }));
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    const body = await res.text();
    // The theme set radius:rounded → --radius:18px (the theme owns its look)...
    assert.match(body, /--radius:18px/, 'the theme radius token drives the head');
    // ...and the tenant-level theme fills the keys the theme left unset (its brand colour + container).
    assert.match(body, /--accent:#ff0000/, 'the tenant brand colour fills via fallback');
    assert.match(body, /--maxw:1200px/, 'the tenant container:wide fills via fallback');
  }
);

test('a data-sourced page carries its data tags in x-surrogate-keys', { skip }, async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': T6 }));
  assert.equal(res.headers.get('x-handler'), 'theme-bundle');
  const keys = res.headers.get('x-surrogate-keys') || '';
  // The resolver's collection tag rides along so a collection change purges this page (D2).
  assert.ok(keys.includes('col:summer'), `expected col:summer in surrogate keys, got: ${keys}`);
});

test(
  'OFCE-601 P0: a base-adopting store renders base sections + one override section end-to-end',
  { skip },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': T7 }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    assert.ok(res.headers.get('x-theme-version'), 'served a published version');
    const body = await res.text();
    assert.match(body, /^<!doctype html>/);
    // Sections from the shared library BASE render (the store didn't touch them) — the default theme's
    // header/footer use the storefront design-system classes (.hdr/.ftr).
    assert.match(body, /class="hdr"/, 'base header section composes in');
    assert.match(body, /class="ftr"/, 'base footer section composes in');
    // ...alongside the merchant's OVERRIDE section, which replaced the base hero and still binds the
    // base template's data (the default home hero heading) through the sandbox isolate.
    assert.match(body, /<section class="mine"><h1>MERCHANT New season, new look<\/h1><\/section>/);
    assert.doesNotMatch(
      body,
      /class="hero"/,
      'the override replaced the base hero, not appended to it'
    );
  }
);
