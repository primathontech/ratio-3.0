// Slice 1 (OFCE-601): publishing the shared Default base + a store adopting it, against real Postgres
// + MinIO. Proves base⊕overrides is turned on for real — a store on the base renders base sections +
// its own override section. Needs DATABASE_URL (migrated) + S3_TEST_ENDPOINT (MinIO).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme/theme-store';
import {
  ensureDefaultBaseTheme,
  ensureSeededBase,
  adoptAndPublishDefaultTheme,
  DEFAULT_BASE_THEME_ID,
} from '../theme/base-library';
import { defaultBundleTheme } from '../theme/default-theme';

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
const ONBOARD_TENANT = 't_lib_onboard';
const ONBOARD_THEME = 't_lib_onboard-main';
const identity: CompileFn = (s) => s;
let store: ThemeStore;

// Clean up only this test's own store + tenant. The shared Default base (library-default / _library)
// is a persistent, idempotent fixture — leaving it avoids a cross-file FK-delete race with other
// suites that also adopt it, and ensureDefaultBaseTheme re-freezes its bytes on demand.
async function cleanup() {
  for (const t of [STORE_TENANT, ONBOARD_TENANT]) {
    await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [t]);
  }
  await pool.query('DELETE FROM theme WHERE id = ANY($1)', [[STORE_THEME, ONBOARD_THEME]]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[STORE_TENANT, ONBOARD_TENANT]]);
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

test('publishes the Default base, idempotently', { skip }, async () => {
  const a = await ensureDefaultBaseTheme(store, { compile: identity });
  assert.equal(a.themeId, DEFAULT_BASE_THEME_ID);
  const before = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM theme_bundle_version WHERE theme_id = $1',
    [DEFAULT_BASE_THEME_ID]
  );
  // Same default content, bytes present → same version; no new version row is cut.
  const b = await ensureDefaultBaseTheme(store, { compile: identity });
  assert.equal(b.version, a.version);
  const after = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM theme_bundle_version WHERE theme_id = $1',
    [DEFAULT_BASE_THEME_ID]
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test(
  'ensureSeededBase seeds v1 from files, then never republishes from files (SEED-ONLY, OFCE-656)',
  { skip },
  async () => {
    // A throwaway base, so we exercise the seed-only rule without mutating the shared library-default.
    const T = '_seed_lib';
    const TH = 'seed_base';
    const seeded = { tenantId: T, tenantName: 'Seed Lib', themeId: TH, themeName: 'Seed' };
    const V1 = {
      'layout/theme.liquid': '<!doctype html><html><body>{{ content_for_layout }}</body></html>',
    };
    await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [TH]);
    await pool.query('DELETE FROM theme WHERE id = $1', [TH]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [T]);

    // First call seeds v1 from the code files; a second call with the same files is a no-op.
    assert.equal(
      (await ensureSeededBase(store, seeded, { files: V1, compile: identity })).version,
      1
    );
    assert.equal(
      (await ensureSeededBase(store, seeded, { files: V1, compile: identity })).version,
      1
    );

    // Simulate a platform admin editing the base via the editor: publish a diverged v2 directly.
    await store.saveDraft(
      { themeId: TH, tenantId: T },
      {
        'layout/theme.liquid':
          '<!doctype html><html><body>ADMIN {{ content_for_layout }}</body></html>',
      }
    );
    assert.equal(
      (await store.publish({ themeId: TH, tenantId: T }, { compile: identity, makeLive: false }))
        .version,
      2
    );

    // Seed-only: calling again with the ORIGINAL code files must NOT clobber the admin's v2 — it stays
    // the latest, and no third version is cut. (Pre-OFCE-656 this would have published a v3 reverting it.)
    assert.equal(
      (await ensureSeededBase(store, seeded, { files: V1, compile: identity })).version,
      2
    );
    const n = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM theme_bundle_version WHERE theme_id = $1',
      [TH]
    );
    assert.equal(n.rows[0].n, 2, 'no third version cut — code never overwrites an edited base');

    await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [TH]);
    await pool.query('DELETE FROM theme WHERE id = $1', [TH]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  }
);

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
      { themeId: STORE_THEME, tenantId: STORE_TENANT },
      {
        'sections/hero.liquid': '<section>MY HERO</section>',
        'sections/promo.liquid': '<section>PROMO</section>',
      }
    );
    await store.publish({ themeId: STORE_THEME, tenantId: STORE_TENANT }, { compile: identity }); // makes STORE_THEME live

    const composed = await store.loadLiveCompiled(STORE_TENANT);
    const base = defaultBundleTheme();
    assert.equal(composed?.['sections/hero.liquid'], '<section>MY HERO</section>'); // override wins
    assert.equal(composed?.['sections/promo.liquid'], '<section>PROMO</section>'); // merchant-added
    assert.equal(composed?.['layout/theme.liquid'], base['layout/theme.liquid']); // untouched → base
    assert.equal(composed?.['sections/footer.liquid'], base['sections/footer.liquid']); // untouched base section
  }
);

test(
  'adoptAndPublishDefaultTheme sets the live pointer so a store renders the bundle from onboarding',
  { skip },
  async () => {
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Onboarded') ON CONFLICT (id) DO NOTHING`,
      [ONBOARD_TENANT]
    );
    // No live theme before — this is exactly a freshly-onboarded store (OFCE-616).
    const before = await pool.query<{ live: string | null }>(
      'SELECT live_theme_id AS live FROM tenants WHERE id = $1',
      [ONBOARD_TENANT]
    );
    assert.equal(before.rows[0].live, null);

    const { version } = await adoptAndPublishDefaultTheme(store, ONBOARD_TENANT, ONBOARD_THEME, {
      compile: identity,
    });
    assert.ok(version >= 1);

    // The tenant now points at this theme's published version — the origin's bundle gate is on.
    const after = await pool.query<{ live: string | null; v: number | null }>(
      'SELECT live_theme_id AS live, live_theme_version AS v FROM tenants WHERE id = $1',
      [ONBOARD_TENANT]
    );
    assert.equal(after.rows[0].live, ONBOARD_THEME);
    assert.equal(after.rows[0].v, version);

    // ...and the live compiled bundle is the full default theme (its home template + per-theme tokens).
    const composed = await store.loadLiveCompiled(ONBOARD_TENANT);
    assert.ok(composed?.['templates/index.json'], 'the default home template is live');
    assert.ok(composed?.['config/tokens.json'], 'the theme carries its own brand tokens');
  }
);
