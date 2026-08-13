// ThemeStore over a REAL S3-compatible store (MinIO) — draft round-trip + publish freezing
// content-addressed source + compiled bundles. Gated on S3_TEST_ENDPOINT (see s3.test.ts); run with
//   docker compose up -d minio  then  S3_TEST_ENDPOINT=http://localhost:9000 ... bun run test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore, type ObjectStore } from '@ratio/data-objects';
import { ThemeStore, type CompileFn } from '../theme-store';
import type { ThemeFiles } from '../bundle';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT with `docker compose up -d minio`';

const identity: CompileFn = (s) => s;
const files: ThemeFiles = {
  'sections/hero.liquid': '<h1>{{ hero.heading }}</h1>',
  'templates/index.json': '{"sections":["hero"]}',
};
// A unique theme id per run so repeated runs (immutable draft key) don't collide.
const ref = { themeId: `t_${Date.now()}` };

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

test('readDraft is empty before any save', { skip }, async () => {
  assert.deepEqual(await store.readDraft({ themeId: `${ref.themeId}_empty` }), {});
});

test('saveDraft → readDraft round-trips the files', { skip }, async () => {
  const { hash } = await store.saveDraft(ref, files);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await store.readDraft(ref), files);
});

test('freezeBundles writes source + compiled bundles, loadable by hash', { skip }, async () => {
  await store.saveDraft(ref, files);
  const { sourceHash, compiledHash } = await store.freezeBundles(ref, { compile: identity });
  // identity compile → the compiled bundle equals the source bundle → same content address.
  assert.equal(compiledHash, sourceHash);
  assert.deepEqual(await store.loadSource(sourceHash), files);
  assert.deepEqual(await store.loadCompiled(compiledHash), files);
});

test('a real compile transform yields a different compiled hash', { skip }, async () => {
  await store.saveDraft(ref, files);
  const compile: CompileFn = (s) => ({ ...s, 'BUILT.txt': 'compiled marker' });
  const { sourceHash, compiledHash } = await store.freezeBundles(ref, { compile });
  assert.notEqual(compiledHash, sourceHash);
  const compiled = await store.loadCompiled(compiledHash);
  assert.equal(compiled?.['BUILT.txt'], 'compiled marker');
});

test('loadCompiled returns null for an unknown hash', { skip }, async () => {
  assert.equal(await store.loadCompiled('0'.repeat(64)), null);
});

// OFCE-604 #4: compiled bundles are content-addressed (immutable), so loadCompiled caches them in a
// per-instance LRU — a repeated load of the same hash must not re-hit the object store. Uses an
// in-memory store, so it runs without MinIO.
test('loadCompiled caches by hash — the object store is read once for repeated loads', async () => {
  const mem = new Map<string, Uint8Array>();
  let gets = 0;
  const objects: ObjectStore = {
    put: async (k, b) => {
      mem.set(k, b as Uint8Array);
      return { etag: 'x' };
    },
    get: async (k) => {
      gets++;
      return mem.get(k) ?? null;
    },
    head: async (k) => (mem.has(k) ? { etag: 'x' } : null),
    delete: async (k) => {
      mem.delete(k);
    },
  };
  const s = new ThemeStore(objects);
  await s.saveDraft({ themeId: 't_lru' }, files);
  const { compiledHash } = await s.freezeBundles({ themeId: 't_lru' }, { compile: identity });
  gets = 0;
  assert.deepEqual(await s.loadCompiled(compiledHash), files);
  assert.deepEqual(await s.loadCompiled(compiledHash), files);
  assert.equal(gets, 1); // second load served from the in-memory LRU
});
