// OFCE-646 origin asset serving: a store's LIVE theme references a binary asset in config/assets.json;
// the origin serves /assets/<hash> from the content-hash store with the manifest's content-type,
// nosniff, and an immutable cache. It serves ONLY hashes the live manifest references (never an
// arbitrary blob), and 404s an unknown/non-hex hash. In-process via app.fetch(), real PG + MinIO.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, assetHash, readAssetManifest, tenantTag } from '@ratio/builder-core';
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

const T = 'themeasset_o1';
const THEME = 'themeasset_o1_main';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]); // a (tiny) favicon, referenced as assets/favicon.ico
const ORPHAN = new Uint8Array([9, 9, 9, 9]); // stored but NOT referenced by the live manifest
const EVIL = new Uint8Array([60, 115, 99, 114, 105, 112, 116, 62]); // "<script>" — referenced with a lying content-type
const call = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request('http://origin' + path, { headers: { 'x-edge-auth': SECRET, ...headers } })
  );
let store: ThemeStore;

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Asset Store', 'active')", [
    T,
  ]);

  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(T, THEME);
  // Store two assets; only the first is referenced by the manifest.
  const logo = await store.putAsset({ themeId: THEME, tenantId: T }, PNG, 'image/png');
  const favicon = await store.putAsset({ themeId: THEME, tenantId: T }, ICO, 'image/x-icon');
  await store.putAsset({ themeId: THEME, tenantId: T }, ORPHAN, 'image/png');
  await store.putAsset({ themeId: THEME, tenantId: T }, EVIL, 'image/png');
  await store.saveDraft(
    { themeId: THEME, tenantId: T },
    {
      // Full theme ownership (OFCE-641): the origin renders the theme's own layout — no shell fallback.
      'layout/theme.liquid':
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>{{ content_for_layout }}</body></html>',
      // The manifest is merchant-editable — the `evil.html` entry is a TAMPERED one claiming text/html for
      // referenced bytes, simulating a hand-edited config/assets.json trying to smuggle stored HTML.
      'config/assets.json': JSON.stringify({
        'images/logo.png': logo,
        'assets/favicon.ico': favicon,
        'evil.html': { hash: assetHash(EVIL), contentType: 'text/html', size: EVIL.byteLength },
      }),
      // A PWA manifest rides the bundle as text (application/json isn't an allowed binary-asset type).
      'manifest.json': JSON.stringify({ name: 'Asset Store', display: 'standalone' }),
      // The section REFERENCES the asset via asset_url (OFCE-647) — the page must render /assets/<hash>.
      'sections/hero.liquid': `<h1>hi</h1><img src="{{ 'images/logo.png' | asset_url }}">`,
      'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
    }
  );
  await store.publish({ themeId: THEME, tenantId: T }, { compile: (s) => s }); // makes it live
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
});

test(
  'serves a referenced asset from /assets/<hash> with content-type + nosniff + immutable',
  { skip },
  async () => {
    const hash = assetHash(PNG);
    const res = await call(`/assets/${hash}`, { 'x-ratio-tenant': T });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-asset');
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'no MIME sniffing');
    assert.match(res.headers.get('cache-control') || '', /immutable/);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(Buffer.from(body), Buffer.from(PNG), 'the exact bytes are served');
  }
);

test(
  'serves the asset with an optional name/ext suffix (/assets/<hash>.png)',
  { skip },
  async () => {
    const res = await call(`/assets/${assetHash(PNG)}.png`, { 'x-ratio-tenant': T });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  }
);

test(
  'neutralizes a tampered manifest content-type — serves text/html-claiming bytes as octet-stream',
  { skip },
  async () => {
    // The live manifest references EVIL with a lying contentType: 'text/html'. The bytes are served (the
    // hash IS referenced), but as application/octet-stream — never active HTML the browser would execute
    // (and would otherwise CDN-cache immutably). This is the public-storefront stored-XSS guard.
    const res = await call(`/assets/${assetHash(EVIL)}`, { 'x-ratio-tenant': T });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'application/octet-stream',
      'the tampered text/html type is neutralized'
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
);

test(
  '404s a valid-hex hash the live manifest does not reference (no arbitrary-blob access)',
  { skip },
  async () => {
    // ORPHAN is really in the bucket, but the live theme never references it → must not be servable.
    const res = await call(`/assets/${assetHash(ORPHAN)}`, { 'x-ratio-tenant': T });
    assert.equal(res.status, 404);
  }
);

test(
  '404s a non-hex /assets path (never falls through to HTML) + keeps nosniff',
  { skip },
  async () => {
    const res = await call('/assets/not-a-hash.png', { 'x-ratio-tenant': T });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
);

test(
  'e2e (OFCE-649): a page referencing asset_url renders /assets/<hash>, which the origin serves',
  { skip },
  async () => {
    // The home section uses {{ 'images/logo.png' | asset_url }} — rendered through the real isolate,
    // asset_url resolves to /assets/<hash> in the page, and that URL serves the bytes. Full chain:
    // upload (store) -> reference (asset_url) -> render (page) -> serve (origin).
    const home = await call('/', { 'x-ratio-tenant': T });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-handler'), 'theme-bundle');
    const hash = assetHash(PNG);
    assert.match(
      await home.text(),
      new RegExp(`<img src="/assets/${hash}">`),
      'asset_url resolved in the rendered page (through the worker isolate)'
    );
    const asset = await call(`/assets/${hash}`, { 'x-ratio-tenant': T });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'image/png');
  }
);

test(
  'serves /favicon.ico from the live theme asset (OFCE-631) — short cache, not immutable',
  { skip },
  async () => {
    const res = await call('/favicon.ico', { 'x-ratio-tenant': T });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'well-known');
    assert.equal(res.headers.get('content-type'), 'image/x-icon');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const cc = res.headers.get('cache-control') || '';
    assert.match(cc, /max-age=\d+/);
    assert.doesNotMatch(cc, /immutable/, 'a re-uploaded favicon must be able to self-heal');
    // Rides the tenant tag so a theme publish purges it at the edge (not TTL-only).
    assert.equal(res.headers.get('x-surrogate-keys'), tenantTag(T));
    const body = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(Buffer.from(body), Buffer.from(ICO), 'the favicon bytes are served');
  }
);

test(
  'serves /manifest.json from the live theme bundle as application/json (OFCE-631)',
  { skip },
  async () => {
    const res = await call('/manifest.json', { 'x-ratio-tenant': T });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'well-known');
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = JSON.parse(await res.text());
    assert.equal(body.name, 'Asset Store');
  }
);

test(
  '404s /favicon.ico with no tenant header (never falls through to HTML)',
  { skip },
  async () => {
    const res = await call('/favicon.ico');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
);

test(
  'the asset manifest freezes immutably into the published version (OFCE-648)',
  { skip },
  async () => {
    // The store published v1 with the logo in config/assets.json. Its frozen compiled bundle carries that
    // manifest, content-addressed — so the version is immutable and a later upload cuts a NEW version.
    const live = readAssetManifest((await store.loadLiveCompiled(T)) ?? {});
    assert.equal(
      live['images/logo.png']?.hash,
      assetHash(PNG),
      'the published version froze the manifest'
    );
  }
);
