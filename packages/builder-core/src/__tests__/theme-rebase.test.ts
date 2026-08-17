// OFCE-640 rebase: pull a NEW base version into a store that already adopted an older one. The store's
// base_version bumps, it republishes (base@new ⊕ its overrides), and goes live — so non-overridden base
// files (e.g. layout/theme.liquid) pick up the new base while the merchant's edits are preserved. This
// is how live stores migrate onto the full-document layout (Phase 1) without losing customizations.
// Real Postgres + MinIO; gated on S3_TEST_ENDPOINT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme/theme-store';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO) with a migrated DATABASE_URL';

const BASE_TENANT = '_rebase_lib';
const BASE_THEME = 'rebase_base';
const STORE_TENANT = 't_rebase_store';
const STORE_THEME = 't_rebase_store_main';
const STORE_THEME_ALT = 't_rebase_store_alt'; // a second, NON-live theme of the same store
const STORE_THEME_DIRTY = 't_rebase_store_dirty'; // has an unpublished draft edit
const STORE_THEME_FAIL = 't_rebase_store_fail'; // used for the publish-fails-then-retry path
const ROOT_TENANT = 't_rebase_root';
const ROOT_THEME = 't_rebase_root_main';
const identity: CompileFn = (s) => s;
let store: ThemeStore;

async function cleanup() {
  const allThemes = [
    BASE_THEME,
    STORE_THEME,
    STORE_THEME_ALT,
    STORE_THEME_DIRTY,
    STORE_THEME_FAIL,
    ROOT_THEME,
  ];
  for (const th of allThemes)
    await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [th]);
  for (const t of [BASE_TENANT, STORE_TENANT, ROOT_TENANT])
    await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [t]);
  await pool.query('DELETE FROM theme WHERE id = ANY($1)', [allThemes]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [
    [BASE_TENANT, STORE_TENANT, ROOT_TENANT],
  ]);
}

const V1 = {
  'layout/theme.liquid': '{{ content_for_layout }}', // body-only (pre-migration)
  'sections/hero.liquid': '<h1>base hero v1</h1>',
  'sections/footer.liquid': '<footer>base footer v1</footer>',
  'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
};
const V2 = {
  'layout/theme.liquid':
    '<!doctype html><html><body>{{ content_for_layout }}{{ footer }}</body></html>', // full document
  'sections/hero.liquid': '<h1>base hero v2</h1>',
  'sections/footer.liquid': '<footer>base footer v2</footer>',
  'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
};

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

  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Rebase Lib')`, [BASE_TENANT]);
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Rebase Store')`, [STORE_TENANT]);
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Rebase Root')`, [ROOT_TENANT]);

  // Base v1 (body-only layout).
  await store.ensureTheme(BASE_TENANT, BASE_THEME, 'Base');
  await store.saveDraft({ themeId: BASE_THEME, tenantId: BASE_TENANT }, V1);
  await store.publish(
    { themeId: BASE_THEME, tenantId: BASE_TENANT },
    { compile: identity, makeLive: false }
  );

  // A store adopts base v1 and overrides ONE section (its hero); publish → live on v1.
  await store.ensureTheme(STORE_TENANT, STORE_THEME, 'Store', { themeId: BASE_THEME, version: 1 });
  await store.saveDraft(
    { themeId: STORE_THEME, tenantId: STORE_TENANT },
    { 'sections/hero.liquid': '<h1>MY hero</h1>' }
  );
  await store.publish({ themeId: STORE_THEME, tenantId: STORE_TENANT }, { compile: identity });

  // Base v2 (full-document layout + changed footer) is published — the "bump".
  await store.saveDraft({ themeId: BASE_THEME, tenantId: BASE_TENANT }, V2);
  await store.publish(
    { themeId: BASE_THEME, tenantId: BASE_TENANT },
    { compile: identity, makeLive: false }
  );

  // A SECOND theme of the same store, adopting base v1 but NOT made live — rebasing it must never
  // hijack the store's live pointer away from STORE_THEME.
  await store.ensureTheme(STORE_TENANT, STORE_THEME_ALT, 'Store Alt', {
    themeId: BASE_THEME,
    version: 1,
  });
  await store.saveDraft(
    { themeId: STORE_THEME_ALT, tenantId: STORE_TENANT },
    { 'sections/hero.liquid': '<h1>ALT hero</h1>' }
  );
  await store.publish(
    { themeId: STORE_THEME_ALT, tenantId: STORE_TENANT },
    { compile: identity, makeLive: false }
  );

  // A theme with an UNPUBLISHED draft edit (published one thing, then edited the draft without
  // publishing) — rebase must refuse it so the migration never ships mid-edit work.
  await store.ensureTheme(STORE_TENANT, STORE_THEME_DIRTY, 'Store Dirty', {
    themeId: BASE_THEME,
    version: 1,
  });
  await store.saveDraft(
    { themeId: STORE_THEME_DIRTY, tenantId: STORE_TENANT },
    { 'sections/hero.liquid': '<h1>published</h1>' }
  );
  await store.publish(
    { themeId: STORE_THEME_DIRTY, tenantId: STORE_TENANT },
    { compile: identity, makeLive: false }
  );
  await store.saveDraft(
    { themeId: STORE_THEME_DIRTY, tenantId: STORE_TENANT },
    { 'sections/hero.liquid': '<h1>WIP unpublished</h1>' } // diverges from the published source
  );

  // A clean theme for the failure-path test (publish throws → base pin restored → retry succeeds).
  await store.ensureTheme(STORE_TENANT, STORE_THEME_FAIL, 'Store Fail', {
    themeId: BASE_THEME,
    version: 1,
  });
  await store.saveDraft(
    { themeId: STORE_THEME_FAIL, tenantId: STORE_TENANT },
    { 'sections/hero.liquid': '<h1>fail hero</h1>' }
  );
  await store.publish(
    { themeId: STORE_THEME_FAIL, tenantId: STORE_TENANT },
    { compile: identity, makeLive: false }
  );

  // A standalone root theme (no base) — rebase must refuse it.
  await store.ensureTheme(ROOT_TENANT, ROOT_THEME, 'Root');
  await store.saveDraft(
    { themeId: ROOT_THEME, tenantId: ROOT_TENANT },
    { 'templates/index.json': '{}' }
  );
  await store.publish({ themeId: ROOT_THEME, tenantId: ROOT_TENANT }, { compile: identity });
});

after(async () => {
  if (skip) return;
  await cleanup();
  await pool.end();
});

test(
  'before rebase: the live store is still on base v1 (body-only layout, its own hero)',
  { skip },
  async () => {
    const live = await store.loadLiveCompiled(STORE_TENANT);
    assert.equal(
      live?.['layout/theme.liquid'],
      V1['layout/theme.liquid'],
      'still the v1 body-only layout'
    );
    assert.equal(live?.['sections/hero.liquid'], '<h1>MY hero</h1>', 'the override');
    assert.equal(live?.['sections/footer.liquid'], V1['sections/footer.liquid'], 'v1 footer');
  }
);

test(
  'rebaseToBase bumps the base version, republishes live, and preserves overrides',
  { skip },
  async () => {
    const before = await pool.query<{ v: number }>(
      'SELECT base_version AS v FROM theme WHERE id = $1',
      [STORE_THEME]
    );
    assert.equal(Number(before.rows[0].v), 1);

    const res = await store.rebaseToBase(STORE_TENANT, STORE_THEME, {
      compile: identity,
      by: 'migrator',
    });
    assert.equal(res.baseVersion, 2, 'rebased onto the latest base version');

    // The theme now tracks base v2, and the live pointer moved to the new published version.
    const after = await pool.query<{ v: number; live: number | null }>(
      `SELECT th.base_version AS v, t.live_theme_version AS live
       FROM theme th JOIN tenants t ON t.id = th.tenant_id WHERE th.id = $1`,
      [STORE_THEME]
    );
    assert.equal(Number(after.rows[0].v), 2);
    assert.equal(
      Number(after.rows[0].live),
      res.version,
      'the store is live on the rebased version'
    );

    const live = await store.loadLiveCompiled(STORE_TENANT);
    // The non-overridden layout picks up base v2 (the full-document layout) — the migration's whole point.
    assert.equal(
      live?.['layout/theme.liquid'],
      V2['layout/theme.liquid'],
      'layout upgraded to v2 (full doc)'
    );
    // A non-overridden base section also advances to v2.
    assert.equal(
      live?.['sections/footer.liquid'],
      V2['sections/footer.liquid'],
      'footer advanced to v2'
    );
    // The merchant's override is PRESERVED across the rebase (not clobbered by base v2's hero).
    assert.equal(
      live?.['sections/hero.liquid'],
      '<h1>MY hero</h1>',
      'the override survives the rebase'
    );
  }
);

test('rebaseToBase does NOT move the live pointer for a non-live theme', { skip }, async () => {
  const res = await store.rebaseToBase(STORE_TENANT, STORE_THEME_ALT, { compile: identity });
  assert.equal(res.madeLive, false, 'a non-live theme rebase does not activate it');
  const live = await pool.query<{ id: string | null }>(
    'SELECT live_theme_id AS id FROM tenants WHERE id = $1',
    [STORE_TENANT]
  );
  assert.equal(live.rows[0].id, STORE_THEME, 'the store stays live on its original theme');
});

test('rebaseToBase refuses a root theme that tracks no base', { skip }, async () => {
  await assert.rejects(
    () => store.rebaseToBase(ROOT_TENANT, ROOT_THEME, { compile: identity }),
    /tracks no base/
  );
});

test(
  'rebaseToBase refuses a theme with unpublished draft changes (never ships mid-edit work)',
  { skip },
  async () => {
    await assert.rejects(
      () => store.rebaseToBase(STORE_TENANT, STORE_THEME_DIRTY, { compile: identity }),
      /unpublished draft changes/
    );
    // The base pin is untouched — the store stays on v1 until the merchant publishes or resets the draft.
    const v = await pool.query<{ v: number }>('SELECT base_version AS v FROM theme WHERE id = $1', [
      STORE_THEME_DIRTY,
    ]);
    assert.equal(Number(v.rows[0].v), 1);
  }
);

test(
  'rebaseToBase restores the base pin when publish fails, so a retry still rebases',
  { skip },
  async () => {
    const boom: CompileFn = () => {
      throw new Error('compile boom');
    };
    await assert.rejects(
      () => store.rebaseToBase(STORE_TENANT, STORE_THEME_FAIL, { compile: boom }),
      /boom/
    );
    // The pin was bumped then restored — still v1, so a re-run isn't skipped as 'already latest'.
    const afterFail = await pool.query<{ v: number }>(
      'SELECT base_version AS v FROM theme WHERE id = $1',
      [STORE_THEME_FAIL]
    );
    assert.equal(Number(afterFail.rows[0].v), 1, 'pin restored after the failed publish');
    // Retrying with a working compile now succeeds and advances the pin to v2.
    const res = await store.rebaseToBase(STORE_TENANT, STORE_THEME_FAIL, { compile: identity });
    assert.equal(res.baseVersion, 2);
    const done = await pool.query<{ v: number }>(
      'SELECT base_version AS v FROM theme WHERE id = $1',
      [STORE_THEME_FAIL]
    );
    assert.equal(Number(done.rows[0].v), 2);
  }
);
