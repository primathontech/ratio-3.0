// Binary theme assets (OFCE-631): the manifest helpers are pure (always run); the content-hash asset
// store round-trip needs MinIO (gated on S3_TEST_ENDPOINT).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore } from '../theme/theme-store';
import {
  ASSET_MANIFEST_PATH,
  assetHash,
  isAssetHash,
  readAssetManifest,
  writeAssetManifest,
  type AssetManifest,
} from '../theme/assets';

const H = 'a'.repeat(64); // a valid-looking sha256 hex
const H2 = 'b'.repeat(64);

test('assetHash is deterministic + content-addressed (same bytes → same hash)', () => {
  const a = assetHash(new Uint8Array([1, 2, 3]));
  assert.equal(a, assetHash(new Uint8Array([1, 2, 3])));
  assert.notEqual(a, assetHash(new Uint8Array([1, 2, 4])));
  assert.ok(isAssetHash(a), 'a real hash passes the guard');
});

test('isAssetHash accepts 64-hex only (rejects traversal / short / upper)', () => {
  assert.ok(isAssetHash(H));
  assert.equal(isAssetHash('../../etc/passwd'), false);
  assert.equal(isAssetHash('a'.repeat(63)), false);
  assert.equal(isAssetHash('A'.repeat(64)), false, 'uppercase is not our hex form');
  assert.equal(isAssetHash(''), false);
});

test('write → read round-trips the manifest, sorted + canonical', () => {
  const manifest: AssetManifest = {
    'images/logo.png': { hash: H2, contentType: 'image/png', size: 20 },
    'favicon.ico': { hash: H, contentType: 'image/x-icon', size: 10 },
  };
  const files = writeAssetManifest({}, manifest);
  assert.ok(files[ASSET_MANIFEST_PATH], 'manifest written into the bundle');
  // Canonical: keys are path-sorted so an identical manifest serializes identically (stable hash).
  const json = files[ASSET_MANIFEST_PATH];
  assert.ok(json.indexOf('favicon.ico') < json.indexOf('images/logo.png'), 'paths are sorted');
  assert.deepEqual(readAssetManifest(files), manifest);
});

test('emptying the manifest drops the file entirely (no empty object left behind)', () => {
  const withOne = writeAssetManifest(
    {},
    { 'a.png': { hash: H, contentType: 'image/png', size: 1 } }
  );
  const emptied = writeAssetManifest(withOne, {});
  assert.equal(ASSET_MANIFEST_PATH in emptied, false);
  assert.deepEqual(readAssetManifest(emptied), {});
});

test('readAssetManifest is defensive: malformed / bad-shaped / bad-hash entries are dropped', () => {
  assert.deepEqual(readAssetManifest({ [ASSET_MANIFEST_PATH]: 'not json' }), {});
  assert.deepEqual(readAssetManifest({ [ASSET_MANIFEST_PATH]: '[1,2,3]' }), {}); // array, not object
  assert.deepEqual(readAssetManifest({}), {}); // absent
  // A hand-edited manifest with a traversal hash / missing fields → that entry is filtered out.
  const dirty = JSON.stringify({
    'ok.png': { hash: H, contentType: 'image/png', size: 5 },
    'evil.png': { hash: '../../../etc', contentType: 'image/png', size: 5 }, // bad hash → dropped
    'nofields.png': { contentType: 'image/png' }, // missing hash/size → dropped
  });
  assert.deepEqual(readAssetManifest({ [ASSET_MANIFEST_PATH]: dirty }), {
    'ok.png': { hash: H, contentType: 'image/png', size: 5 },
  });
});

test('a __proto__ asset path never pollutes the returned object (read is defineProperty-safe)', () => {
  // Hand-written JSON with a literal "__proto__" KEY (an object literal `{__proto__:…}` would set the
  // prototype, not a key). JSON.parse turns it into a REAL own property, so a hand-edited manifest can
  // carry it — it must round-trip as a normal entry, not mutate the returned object's prototype.
  const json =
    `{"__proto__":{"hash":"${H}","contentType":"image/png","size":1},` +
    `"z.png":{"hash":"${H2}","contentType":"image/png","size":2}}`;
  const out = readAssetManifest({ [ASSET_MANIFEST_PATH]: json });
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'prototype is untouched');
  assert.equal(out['z.png'].hash, H2);
  assert.ok(
    Object.prototype.hasOwnProperty.call(out, '__proto__'),
    'the __proto__ path is a real own entry'
  );
});

test('writeAssetManifest is byte-canonical regardless of entry field order', () => {
  const scrambled = writeAssetManifest(
    {},
    {
      'x.png': { size: 3, contentType: 'image/png', hash: H } as AssetManifest[string],
    }
  );
  const ordered = writeAssetManifest(
    {},
    {
      'x.png': { hash: H, contentType: 'image/png', size: 3 },
    }
  );
  assert.equal(
    scrambled[ASSET_MANIFEST_PATH],
    ordered[ASSET_MANIFEST_PATH],
    'the same logical manifest serializes to identical bytes → stable bundle hash'
  );
});

// ── Content-hash asset store (MinIO) ─────────────────────────────────────────
const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO)';
const T = 't_assets_store';
const THEME = 't_assets_store_main';
let store: ThemeStore;

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
});
after(async () => {
  if (skip) return;
  await pool.end();
});

test('putAsset stores bytes content-addressed; getAsset round-trips them', { skip }, async () => {
  const ref = { themeId: THEME, tenantId: T };
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // pretend-PNG
  const entry = await store.putAsset(ref, bytes, 'image/png');
  assert.equal(entry.hash, assetHash(bytes), 'entry hash is the content address');
  assert.equal(entry.contentType, 'image/png');
  assert.equal(entry.size, bytes.byteLength);

  const back = await store.getAsset(ref, entry.hash);
  assert.ok(back, 'the asset is retrievable by hash');
  assert.deepEqual(Buffer.from(back!), Buffer.from(bytes), 'bytes round-trip exactly');

  // Content-hash dedup: the same bytes yield the same hash (same object), different bytes differ.
  const again = await store.putAsset(ref, bytes, 'image/png');
  assert.equal(again.hash, entry.hash);
  const other = await store.putAsset(ref, new Uint8Array([9, 9, 9]), 'image/png');
  assert.notEqual(other.hash, entry.hash);
});

test('getAsset returns null for an unknown hash', { skip }, async () => {
  assert.equal(await store.getAsset({ themeId: THEME, tenantId: T }, H2), null);
});

test('getAsset refuses a non-hex hash (no prefix traversal)', { skip }, async () => {
  await assert.rejects(
    () => store.getAsset({ themeId: THEME, tenantId: T }, '../../../etc/passwd'),
    /invalid asset hash/
  );
});
