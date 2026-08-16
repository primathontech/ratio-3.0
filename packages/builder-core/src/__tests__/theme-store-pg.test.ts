// The DB-backed side of ThemeStore, against the real test DB + MinIO: publish records an immutable
// version and flips the tenant's live pointer, and loadLiveCompiled serves that version's compiled
// bundle (what the origin calls on a cache miss). Needs DATABASE_URL (a migrated test DB, applied via
// `bun run migrate`) and S3_TEST_ENDPOINT (`docker compose up -d minio`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore, type ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme-store';
import { tenantTag } from '../tags';
import type { ThemeFiles } from '../bundle';

// Wraps a real store to count writes — used to prove a doomed publish never touches S3.
class CountingStore implements ObjectStore {
  puts = 0;
  constructor(private readonly inner: ObjectStore) {}
  put(key: string, body: Uint8Array, opts?: { contentType?: string }) {
    this.puts++;
    return this.inner.put(key, body, opts);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  head(key: string) {
    return this.inner.head(key);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
}

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO) with a migrated DATABASE_URL';

const TENANT = 't_mca_bundle';
const THEME = 't_mca_bundle_main';
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
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]); // cascades bundle versions + files
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'MCA Bundle Test')`, [TENANT]);
  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(TENANT, THEME);
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  await pool.end();
});

test('loadLiveCompiled is null before publishing', { skip }, async () => {
  assert.equal(await store.loadLiveCompiled(TENANT), null);
});

test(
  'publish records v1, flips the pointer, and serves the compiled bundle',
  { skip },
  async () => {
    await store.saveDraft({ themeId: THEME, tenantId: TENANT }, files);
    const r1 = await store.publish(
      { themeId: THEME, tenantId: TENANT },
      { compile: identity, by: 'tester' }
    );
    assert.equal(r1.version, 1);
    assert.deepEqual(await store.loadLiveCompiled(TENANT), files);
  }
);

test('a second publish bumps the version and moves the pointer', { skip }, async () => {
  await store.saveDraft({ themeId: THEME, tenantId: TENANT }, changed);
  const r2 = await store.publish({ themeId: THEME, tenantId: TENANT }, { compile: identity });
  assert.equal(r2.version, 2);
  assert.deepEqual(await store.loadLiveCompiled(TENANT), changed);
});

test(
  'rollback flips the pointer back to an earlier version, and forward again',
  { skip },
  async () => {
    await store.rollback(TENANT, 1);
    assert.deepEqual(await store.loadLiveCompiled(TENANT), files);
    await store.rollback(TENANT, 2);
    assert.deepEqual(await store.loadLiveCompiled(TENANT), changed);
  }
);

test('rollback to an unknown version throws', { skip }, async () => {
  await assert.rejects(() => store.rollback(TENANT, 999), /unknown version/);
});

test('publish on an unknown theme throws', { skip }, async () => {
  await assert.rejects(
    () => store.publish({ themeId: 'does_not_exist', tenantId: TENANT }, { compile: identity }),
    /unknown theme/
  );
});

// OFCE-604 #6: validate the theme exists BEFORE writing bundles, so a doomed publish leaves no
// orphaned (though harmless, content-addressed) objects in S3.
test('publish on an unknown theme writes no bundles (no S3 orphans)', { skip }, async () => {
  const counting = new CountingStore(new S3ObjectStore({ bucket, ...common }));
  const s = new ThemeStore(counting);
  await assert.rejects(
    () => s.publish({ themeId: 'does_not_exist', tenantId: TENANT }, { compile: identity }),
    /unknown theme/
  );
  assert.equal(counting.puts, 0);
});

// OFCE-604 #5: cutting a version must be separable from making it live — otherwise a store that
// keeps several themes can't record a version without hijacking the live pointer.
test(
  'publish with makeLive:false records a version without moving the live pointer',
  {
    skip,
  },
  async () => {
    const before = await pool.query<{ live_theme_id: string; live_theme_version: number }>(
      'SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1',
      [TENANT]
    );
    const OTHER = 't_mca_bundle_alt';
    await pool.query('DELETE FROM theme WHERE id = $1', [OTHER]);
    await store.ensureTheme(TENANT, OTHER, 'Alt');
    await store.saveDraft({ themeId: OTHER, tenantId: TENANT }, files);
    const r = await store.publish(
      { themeId: OTHER, tenantId: TENANT },
      { compile: identity, makeLive: false }
    );
    assert.equal(r.version, 1);
    const v = await pool.query(
      'SELECT 1 FROM theme_bundle_version WHERE theme_id = $1 AND version = 1',
      [OTHER]
    );
    assert.equal(v.rowCount, 1);
    const after = await pool.query(
      'SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1',
      [TENANT]
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
    await pool.query('DELETE FROM theme WHERE id = $1', [OTHER]);
  }
);

// OFCE-601 purge-on-publish: publishing (or rolling back) a bundle theme changes what the store
// serves, so it enqueues a durable purge of the tenant tag IN the same transaction — the edge drops
// every cached page of that store. Same page_purge_outbox + drainPurges() worker as the legacy path.
test('publish enqueues a durable tenant-tag purge in the outbox', { skip }, async () => {
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [TENANT]);
  await store.saveDraft({ themeId: THEME, tenantId: TENANT }, files);
  await store.publish({ themeId: THEME, tenantId: TENANT }, { compile: identity });
  const { rows } = await pool.query<{ tags: string[] }>(
    'SELECT tags FROM page_purge_outbox WHERE tenant_id = $1',
    [TENANT]
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, [tenantTag(TENANT)]);
});

test(
  'publish with makeLive:false enqueues no purge (nothing served changed)',
  {
    skip,
  },
  async () => {
    const OTHER = 't_mca_bundle_alt2';
    await pool.query('DELETE FROM theme WHERE id = $1', [OTHER]);
    await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [TENANT]);
    await store.ensureTheme(TENANT, OTHER, 'Alt2');
    await store.saveDraft({ themeId: OTHER, tenantId: TENANT }, files);
    await store.publish(
      { themeId: OTHER, tenantId: TENANT },
      { compile: identity, makeLive: false }
    );
    const n = await pool.query('SELECT 1 FROM page_purge_outbox WHERE tenant_id = $1', [TENANT]);
    assert.equal(n.rowCount, 0);
    await pool.query('DELETE FROM theme WHERE id = $1', [OTHER]);
  }
);

test('a half-set live pointer is rejected by the DB (all-or-nothing)', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO tenants (id, name, live_theme_id) VALUES ('t_mca_halfptr', 'Half', 'x')`
      ),
    /tenants_live_theme_pair_ck|check constraint/
  );
});
