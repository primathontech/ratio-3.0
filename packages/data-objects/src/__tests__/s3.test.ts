// S3ObjectStore against a REAL S3-compatible store (MinIO) — no mocks, same spirit as the DB tests
// running against a real test Postgres. Gated on S3_TEST_ENDPOINT so the suite skips cleanly when
// MinIO isn't up. To run it:  docker compose up -d minio  then
//   S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_KEY=poc S3_TEST_SECRET=poc12345 bun run test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '../s3';

const endpoint = process.env.S3_TEST_ENDPOINT; // e.g. http://localhost:9000
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };

const skip = endpoint
  ? false
  : 'set S3_TEST_ENDPOINT (e.g. http://localhost:9000) with `docker compose up -d minio`';

let store: S3ObjectStore;

before(async () => {
  if (skip) return;
  // Ensure the bucket exists (idempotent).
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  store = new S3ObjectStore({ bucket, ...common });
});

test('put → get round-trips the bytes', { skip }, async () => {
  const key = `themes/${Date.now()}/hello.txt`;
  const { etag } = await store.put(key, new TextEncoder().encode('hello bundle'));
  assert.ok(etag.length > 0, 'put returns an etag');
  const got = await store.get(key);
  assert.equal(got && Buffer.from(got).toString('utf8'), 'hello bundle');
});

test('get returns null for a missing key', { skip }, async () => {
  assert.equal(await store.get(`missing/${Date.now()}`), null);
});

test('head returns an etag when present, null when absent', { skip }, async () => {
  const key = `themes/${Date.now()}/h.txt`;
  assert.equal(await store.head(key), null);
  await store.put(key, new TextEncoder().encode('x'));
  const h = await store.head(key);
  assert.ok(h && h.etag.length > 0);
});

test('delete removes the object and is idempotent', { skip }, async () => {
  const key = `themes/${Date.now()}/d.txt`;
  await store.put(key, new TextEncoder().encode('x'));
  await store.delete(key);
  assert.equal(await store.get(key), null);
  await store.delete(key); // no throw when already gone
});
