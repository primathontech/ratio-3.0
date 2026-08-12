// ThemeStore over a REAL S3-compatible store (MinIO) — draft round-trip + publish freezing
// content-addressed source + compiled bundles. Gated on S3_TEST_ENDPOINT (see s3.test.ts); run with
//   docker compose up -d minio  then  S3_TEST_ENDPOINT=http://localhost:9000 ... bun run test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
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
