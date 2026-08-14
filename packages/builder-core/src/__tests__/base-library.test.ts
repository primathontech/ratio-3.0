// Slice 1 (OFCE-601): publishing the shared Default base + a store adopting it, against real Postgres
// + MinIO. Proves base⊕overrides is turned on for real — a store on the base renders base sections +
// its own override section. Needs DATABASE_URL (migrated) + S3_TEST_ENDPOINT (MinIO).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme-store';
import { ensureDefaultBaseTheme, DEFAULT_BASE_THEME_ID, LIBRARY_TENANT_ID } from '../base-library';
import { defaultBundleTheme } from '../default-theme';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO) with a migrated DATABASE_URL';

const STORE_TENANT = 't_lib_store';
const STORE_THEME = 't_lib_store_main';
const identity: CompileFn = (s) => s;
let store: ThemeStore;

async function cleanup() {
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = ANY($1)', [
    [STORE_TENANT, LIBRARY_TENANT_ID],
  ]);
  // The store theme's base_theme_id FKs the library base, so delete the child first, then the base,
  // then the tenants.
  await pool.query('DELETE FROM theme WHERE id = $1', [STORE_THEME]);
  await pool.query('DELETE FROM theme WHERE id = $1', [DEFAULT_BASE_THEME_ID]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[STORE_TENANT, LIBRARY_TENANT_ID]]);
}

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await cleanup();
  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
});

after(async () => {
  if (skip) return;
  await cleanup();
  await pool.end();
});

test('publishes the Default base once, idempotently', { skip }, async () => {
  const a = await ensureDefaultBaseTheme(store, { compile: identity });
  assert.equal(a.themeId, DEFAULT_BASE_THEME_ID);
  assert.equal(a.version, 1);
  // Same default content → same version; no second version row is cut.
  const b = await ensureDefaultBaseTheme(store, { compile: identity });
  assert.equal(b.version, 1);
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM theme_bundle_version WHERE theme_id = $1',
    [DEFAULT_BASE_THEME_ID]
  );
  assert.equal(rows[0].n, 1);
});

test(
  'a store adopting the base renders base sections + its override section',
  { skip },
  async () => {
    const { version } = await ensureDefaultBaseTheme(store, { compile: identity });
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Lib Store') ON CONFLICT (id) DO NOTHING`,
      [STORE_TENANT]
    );
    await store.ensureTheme(STORE_TENANT, STORE_THEME, 'Store', {
      themeId: DEFAULT_BASE_THEME_ID,
      version,
    });
    // The merchant overrides one base section and adds a brand-new one.
    await store.saveDraft(
      { themeId: STORE_THEME },
      {
        'sections/hero.liquid': '<section>MY HERO</section>',
        'sections/promo.liquid': '<section>PROMO</section>',
      }
    );
    await store.publish({ themeId: STORE_THEME }, { compile: identity }); // makes STORE_THEME live

    const composed = await store.loadLiveCompiled(STORE_TENANT);
    const base = defaultBundleTheme();
    assert.equal(composed?.['sections/hero.liquid'], '<section>MY HERO</section>'); // override wins
    assert.equal(composed?.['sections/promo.liquid'], '<section>PROMO</section>'); // merchant-added
    assert.equal(composed?.['layout/theme.liquid'], base['layout/theme.liquid']); // untouched → base
    assert.equal(composed?.['sections/footer.liquid'], base['sections/footer.liquid']); // untouched base section
  }
);
