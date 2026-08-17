// OFCE-646 origin asset serving: a store's LIVE theme references a binary asset in config/assets.json;
// the origin serves /assets/<hash> from the content-hash store with the manifest's content-type,
// nosniff, and an immutable cache. It serves ONLY hashes the live manifest references (never an
// arbitrary blob), and 404s an unknown/non-hex hash. In-process via app.fetch(), real PG + MinIO.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, assetHash } from '@ratio/builder-core';
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
const ORPHAN = new Uint8Array([9, 9, 9, 9]); // stored but NOT referenced by the live manifest
const call = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request('http://origin' + path, { headers: { 'x-edge-auth': SECRET, ...headers } })
  );

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

  const store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(T, THEME);
  // Store two assets; only the first is referenced by the manifest.
  const logo = await store.putAsset({ themeId: THEME, tenantId: T }, PNG, 'image/png');
  await store.putAsset({ themeId: THEME, tenantId: T }, ORPHAN, 'image/png');
  await store.saveDraft(
    { themeId: THEME, tenantId: T },
    {
      'config/assets.json': JSON.stringify({ 'images/logo.png': logo }),
      'sections/hero.liquid': '<h1>hi</h1>',
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
