// base ⊕ overrides in the ThemeStore (LLD Bucket E), against real Postgres + MinIO: a store's theme
// tracks an immutable base and keeps only its overrides; publish freezes the OVERRIDES as the source
// bundle and compile(base ⊕ overrides) as the compiled bundle (what the origin serves). Needs
// DATABASE_URL (migrated) + S3_TEST_ENDPOINT (MinIO).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme/theme-store';
import { DELETES_MANIFEST } from '../theme/theme-compose';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO) with a migrated DATABASE_URL';

const TENANT = 't_mca_base';
const BASE = 't_mca_base_default';
const CHILD = 't_mca_base_child';
const GRANDCHILD = 't_mca_base_grandchild';
const DANGLING = 't_mca_base_dangling';
const ALL_THEMES = [BASE, CHILD, GRANDCHILD, DANGLING];
const identity: CompileFn = (s) => s;
let store: ThemeStore;

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  // Reverse order: a child's base FK means the base row must be deleted last.
  for (const id of [...ALL_THEMES].reverse())
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'MCA Base Test')`, [TENANT]);
  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));

  // The base is a ROOT theme (no base) holding the full default files, published as base@1 (not live).
  await store.ensureTheme(TENANT, BASE);
  await store.saveDraft(
    { themeId: BASE, tenantId: TENANT },
    { 'a.liquid': 'BASE-A', 'b.liquid': 'BASE-B' }
  );
  await store.publish({ themeId: BASE, tenantId: TENANT }, { compile: identity, makeLive: false });
});

after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [TENANT]);
  for (const id of [...ALL_THEMES].reverse())
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  await pool.end();
});

test(
  'publish freezes compile(base ⊕ overrides); loadLiveCompiled serves the composed theme',
  {
    skip,
  },
  async () => {
    await store.ensureTheme(TENANT, CHILD, 'Child', { themeId: BASE, version: 1 });
    await store.saveDraft(
      { themeId: CHILD, tenantId: TENANT },
      { 'a.liquid': 'MINE-A', 'c.liquid': 'MINE-C' }
    );
    await store.publish({ themeId: CHILD, tenantId: TENANT }, { compile: identity }); // makes CHILD live
    assert.deepEqual(await store.loadLiveCompiled(TENANT), {
      'a.liquid': 'MINE-A', // override wins over the base
      'b.liquid': 'BASE-B', // untouched → tracks the base
      'c.liquid': 'MINE-C', // added by the merchant
    });
  }
);

test(
  'readComposed returns base ⊕ the current draft overrides (a _deletes drops a base file)',
  {
    skip,
  },
  async () => {
    await store.saveDraft(
      { themeId: CHILD, tenantId: TENANT },
      { 'a.liquid': 'DRAFT-A', [DELETES_MANIFEST]: JSON.stringify(['b.liquid']) }
    );
    assert.deepEqual(await store.readComposed({ themeId: CHILD, tenantId: TENANT }), {
      'a.liquid': 'DRAFT-A',
    });
  }
);

test(
  'source bundle is the overrides (small); compiled is the full composed theme',
  { skip },
  async () => {
    await store.saveDraft({ themeId: CHILD, tenantId: TENANT }, { 'a.liquid': 'X' });
    const r = await store.publish({ themeId: CHILD, tenantId: TENANT }, { compile: identity });
    assert.deepEqual(await store.loadSource(TENANT, CHILD, r.sourceHash), { 'a.liquid': 'X' }); // overrides only
    assert.deepEqual(await store.loadCompiled(TENANT, CHILD, r.compiledHash), {
      'a.liquid': 'X',
      'b.liquid': 'BASE-B',
    });
  }
);

test(
  'a root theme (no base) freezes its whole draft unchanged: compiled === source',
  { skip },
  async () => {
    await store.saveDraft(
      { themeId: BASE, tenantId: TENANT },
      { 'a.liquid': 'BASE-A', 'b.liquid': 'BASE-B' }
    );
    const r = await store.publish(
      { themeId: BASE, tenantId: TENANT },
      { compile: identity, makeLive: false }
    );
    const src = await store.loadSource(TENANT, BASE, r.sourceHash);
    assert.deepEqual(await store.loadCompiled(TENANT, BASE, r.compiledHash), src); // nothing composed beneath a root
    assert.deepEqual(src, { 'a.liquid': 'BASE-A', 'b.liquid': 'BASE-B' });
  }
);

test('publish throws when the tracked base version has no published bundle', { skip }, async () => {
  await store.ensureTheme(TENANT, DANGLING, 'Dangling', { themeId: BASE, version: 99 });
  await store.saveDraft({ themeId: DANGLING, tenantId: TENANT }, { 'a.liquid': 'MINE' });
  await assert.rejects(
    () => store.publish({ themeId: DANGLING, tenantId: TENANT }, { compile: identity }),
    /base '.*'@99 has no published version/
  );
});

test(
  'publish throws when the tracked base is not a root theme (multi-level base)',
  { skip },
  async () => {
    // CHILD tracks BASE, so CHILD is a non-root. Pointing a theme's base at CHILD would compose CHILD's
    // OVERRIDES as if they were a full theme — silent file loss. It must fail loud instead.
    await store.ensureTheme(TENANT, GRANDCHILD, 'Grandchild', { themeId: CHILD, version: 1 });
    await store.saveDraft({ themeId: GRANDCHILD, tenantId: TENANT }, { 'a.liquid': 'MINE' });
    await assert.rejects(
      () => store.publish({ themeId: GRANDCHILD, tenantId: TENANT }, { compile: identity }),
      /base '.*' is not a root theme/
    );
  }
);
