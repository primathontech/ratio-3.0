// The DB-backed side of ThemeStore, against the real test DB + MinIO: publish records an immutable
// version and flips the store's live pointer, and loadLiveCompiled serves that version's compiled
// bundle (what the origin calls on a cache miss). Needs DATABASE_URL (a migrated test DB, applied via
// `bun run migrate`) and S3_TEST_ENDPOINT (`docker compose up -d minio`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme-store';
import type { ThemeFiles } from '../bundle';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO) with a migrated DATABASE_URL';

const STORE = 'store_mca_test';
const THEME = 'store_mca_test_main';
const identity: CompileFn = (s) => s;
const files: ThemeFiles = { 'sections/hero.liquid': '<h1>{{ hero.heading }}</h1>' };
const changed: ThemeFiles = { ...files, 'assets/theme.css': 'body{color:red}' };

let store: ThemeStore;

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await pool.query('DELETE FROM store_live_theme WHERE store_id = $1', [STORE]);
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]); // cascades bundle versions + files
  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(STORE, THEME);
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM store_live_theme WHERE store_id = $1', [STORE]);
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.end();
});

test('loadLiveCompiled is null before publishing', { skip }, async () => {
  assert.equal(await store.loadLiveCompiled(STORE), null);
});

test(
  'publish records v1, flips the pointer, and serves the compiled bundle',
  { skip },
  async () => {
    await store.saveDraft({ themeId: THEME }, files);
    const r1 = await store.publish({ themeId: THEME }, { compile: identity, by: 'tester' });
    assert.equal(r1.version, 1);
    assert.deepEqual(await store.loadLiveCompiled(STORE), files);
  }
);

test('a second publish bumps the version and moves the pointer', { skip }, async () => {
  await store.saveDraft({ themeId: THEME }, changed);
  const r2 = await store.publish({ themeId: THEME }, { compile: identity });
  assert.equal(r2.version, 2);
  assert.deepEqual(await store.loadLiveCompiled(STORE), changed);
});

test(
  'rollback flips the pointer back to an earlier version, and forward again',
  { skip },
  async () => {
    await store.rollback(STORE, 1);
    assert.deepEqual(await store.loadLiveCompiled(STORE), files);
    await store.rollback(STORE, 2);
    assert.deepEqual(await store.loadLiveCompiled(STORE), changed);
  }
);

test('rollback to an unknown version throws', { skip }, async () => {
  await assert.rejects(() => store.rollback(STORE, 999), /unknown version/);
});

test('publish on an unknown theme throws', { skip }, async () => {
  await assert.rejects(
    () => store.publish({ themeId: 'does_not_exist' }, { compile: identity }),
    /unknown theme/
  );
});
