// Base propagation (OFCE-633): plan + apply the "improve the base once, pull it into every store" flow.
// planBaseRebase previews which stores are behind and what each rebase would do (shadowed files, blockers);
// applyBaseRebase runs the tested rebaseToBase per store, flushing the purge via a callback, and reports
// per-store. Real Postgres + MinIO; gated on S3_TEST_ENDPOINT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';
import { ThemeStore, type CompileFn } from '../theme/theme-store';
import { planBaseRebase, applyBaseRebase } from '../theme/base-propagation';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.S3_TEST_KEY ?? 'poc',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set S3_TEST_ENDPOINT (MinIO) with a migrated DATABASE_URL';

const BASE_TENANT = '_bp_lib';
const BASE_THEME = 'bp_base';
const CLEAN_TENANT = 't_bp_clean'; // live, overrides a file the base ALSO changed → shadow
const CLEAN_THEME = 't_bp_clean_main';
const NOS_TENANT = 't_bp_nos'; // NOT live, overrides a NEW file the base never touched → no shadow
const NOS_THEME = 't_bp_nos_main';
const DIRTY_TENANT = 't_bp_dirty'; // unpublished draft edit → blocked dirty-draft
const DIRTY_THEME = 't_bp_dirty_main';
const BROKEN_TENANT = 't_bp_broken'; // live on a body-only layout override → blocked broken-layout
const BROKEN_THEME = 't_bp_broken_main';
const identity: CompileFn = (s) => s;
let store: ThemeStore;

const ALL_THEMES = [BASE_THEME, CLEAN_THEME, NOS_THEME, DIRTY_THEME, BROKEN_THEME];
const ALL_TENANTS = [BASE_TENANT, CLEAN_TENANT, NOS_TENANT, DIRTY_TENANT, BROKEN_TENANT];

const V1 = {
  'layout/theme.liquid': '{{ content_for_layout }}', // body-only (pre-migration)
  'sections/hero.liquid': '<h1>base hero v1</h1>',
  'sections/footer.liquid': '<footer>base footer v1</footer>',
  'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
};
const V2 = {
  'layout/theme.liquid':
    '<!doctype html><html><body>{{ content_for_layout }}{{ footer }}</body></html>', // full document
  'sections/hero.liquid': '<h1>base hero v2</h1>', // CHANGED
  'sections/footer.liquid': '<footer>base footer v2</footer>', // CHANGED
  'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }), // unchanged
};

async function cleanup() {
  for (const th of ALL_THEMES)
    await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [th]);
  for (const t of ALL_TENANTS)
    await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [t]);
  await pool.query('DELETE FROM theme WHERE id = ANY($1)', [ALL_THEMES]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [ALL_TENANTS]);
}

// Adopt base v1, override some files, and publish. makeLive controls whether it becomes the tenant's
// live theme.
async function seedStore(
  tenantId: string,
  themeId: string,
  overrides: Record<string, string>,
  makeLive: boolean
) {
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `Store ${themeId}`,
  ]);
  await store.ensureTheme(tenantId, themeId, 'Store', { themeId: BASE_THEME, version: 1 });
  await store.saveDraft({ themeId, tenantId }, overrides);
  await store.publish({ themeId, tenantId }, { compile: identity, makeLive });
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

  // Base v1, then a store adopts it, then base v2 is published (the "improvement" to propagate).
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'BP Lib')`, [BASE_TENANT]);
  await store.ensureTheme(BASE_TENANT, BASE_THEME, 'Base');
  await store.saveDraft({ themeId: BASE_THEME, tenantId: BASE_TENANT }, V1);
  await store.publish(
    { themeId: BASE_THEME, tenantId: BASE_TENANT },
    { compile: identity, makeLive: false }
  );

  // Stores adopt base v1 (BEFORE v2 exists, so they're pinned to v1).
  await seedStore(CLEAN_TENANT, CLEAN_THEME, { 'sections/hero.liquid': '<h1>MY hero</h1>' }, true);
  await seedStore(NOS_TENANT, NOS_THEME, { 'sections/custom.liquid': '<x/>' }, false);
  await seedStore(
    BROKEN_TENANT,
    BROKEN_THEME,
    { 'layout/theme.liquid': '{{ content_for_layout }}' },
    true
  );
  // Dirty: publish clean, then edit the draft without publishing.
  await seedStore(
    DIRTY_TENANT,
    DIRTY_THEME,
    { 'sections/hero.liquid': '<h1>published</h1>' },
    false
  );
  await store.saveDraft(
    { themeId: DIRTY_THEME, tenantId: DIRTY_TENANT },
    { 'sections/hero.liquid': '<h1>WIP</h1>' }
  );

  // Base v2 (full-document layout + changed hero/footer) — now every store is one version behind.
  await store.saveDraft({ themeId: BASE_THEME, tenantId: BASE_TENANT }, V2);
  await store.publish(
    { themeId: BASE_THEME, tenantId: BASE_TENANT },
    { compile: identity, makeLive: false }
  );
});

after(async () => {
  if (skip) return;
  await cleanup();
  await pool.end();
});

test(
  'planBaseRebase lists every store behind the base, with shadowed files and blockers',
  { skip },
  async () => {
    const plan = await planBaseRebase(store, { baseThemeId: BASE_THEME });
    assert.equal(plan.latestVersion, 2);
    const by = new Map(plan.targets.map((t) => [t.themeId, t]));

    const clean = by.get(CLEAN_THEME);
    assert.ok(clean, 'clean store is in the plan');
    assert.equal(clean!.fromVersion, 1);
    assert.equal(clean!.toVersion, 2);
    assert.equal(clean!.isLive, true);
    assert.equal(clean!.overrideCount, 1);
    assert.equal(clean!.blocked, null);
    // hero changed in the base v1→v2 AND the store overrode hero → the base's new hero won't reach it.
    assert.deepEqual(clean!.shadowedFiles, ['sections/hero.liquid']);

    const nos = by.get(NOS_THEME);
    assert.ok(nos, 'no-shadow store is in the plan');
    assert.equal(nos!.isLive, false);
    // its only override is a NEW file the base never had → nothing shadowed.
    assert.deepEqual(nos!.shadowedFiles, []);
    assert.equal(nos!.blocked, null);

    assert.equal(by.get(DIRTY_THEME)?.blocked, 'dirty-draft');
    assert.equal(by.get(BROKEN_THEME)?.blocked, 'broken-layout');
  }
);

test(
  'applyBaseRebase advances the base, preserves overrides, flushes purge, reports per-store',
  { skip },
  async () => {
    const plan = await planBaseRebase(store, { baseThemeId: BASE_THEME });
    const purged: string[] = [];
    const outcomes = await applyBaseRebase(
      store,
      plan.targets.map((t) => ({ tenantId: t.tenantId, themeId: t.themeId })),
      { compile: identity, by: 'migrator', onApplied: (t) => void purged.push(t) }
    );
    const res = new Map(outcomes.map((o) => [o.themeId, o]));

    // The two clean stores rebased; the blocked two failed with their reasons, without aborting the batch.
    assert.equal(res.get(CLEAN_THEME)?.ok, true);
    assert.equal(res.get(NOS_THEME)?.ok, true);
    assert.equal(res.get(DIRTY_THEME)?.ok, false);
    assert.match(res.get(DIRTY_THEME)?.error ?? '', /unpublished draft/);
    assert.equal(res.get(BROKEN_THEME)?.ok, false);
    assert.match(res.get(BROKEN_THEME)?.error ?? '', /full HTML document/);

    // onApplied fired ONLY for the successful rebases.
    assert.deepEqual(purged.sort(), [CLEAN_TENANT, NOS_TENANT].sort());

    // The live clean store now serves base v2's layout + footer, with its own hero preserved.
    const live = await store.loadLiveCompiled(CLEAN_TENANT);
    assert.equal(live?.['layout/theme.liquid'], V2['layout/theme.liquid'], 'layout upgraded to v2');
    assert.equal(
      live?.['sections/footer.liquid'],
      V2['sections/footer.liquid'],
      'footer advanced to v2'
    );
    assert.equal(live?.['sections/hero.liquid'], '<h1>MY hero</h1>', 'override preserved');

    // The rebase enqueued a durable cache-purge outbox row for the live store.
    const outbox = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM page_purge_outbox WHERE tenant_id = $1',
      [CLEAN_TENANT]
    );
    assert.ok(outbox.rows[0].n > 0, 'purge outbox row enqueued');
  }
);

test(
  'applyBaseRebase is self-idempotent: re-applying a STALE target list skips already-current stores',
  { skip },
  async () => {
    // Reuse the ORIGINAL (now stale) targets — an admin retry that does NOT re-plan. Every clean store is
    // already on v2, so nothing must republish or re-purge.
    const staleTargets = [
      { tenantId: CLEAN_TENANT, themeId: CLEAN_THEME },
      { tenantId: NOS_TENANT, themeId: NOS_THEME },
    ];
    const versionsBefore = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM theme_bundle_version WHERE theme_id = ANY($1)',
      [[CLEAN_THEME, NOS_THEME]]
    );
    const purgesBefore = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM page_purge_outbox WHERE tenant_id = ANY($1)',
      [[CLEAN_TENANT, NOS_TENANT]]
    );
    const purged: string[] = [];
    const outcomes = await applyBaseRebase(store, staleTargets, {
      compile: identity,
      onApplied: (t) => void purged.push(t),
    });
    assert.ok(
      outcomes.every((o) => o.ok && o.skipped),
      'all skipped as already-current'
    );
    assert.deepEqual(purged, [], 'onApplied not fired for skipped stores');
    const versionsAfter = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM theme_bundle_version WHERE theme_id = ANY($1)',
      [[CLEAN_THEME, NOS_THEME]]
    );
    const purgesAfter = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM page_purge_outbox WHERE tenant_id = ANY($1)',
      [[CLEAN_TENANT, NOS_TENANT]]
    );
    assert.equal(versionsAfter.rows[0].n, versionsBefore.rows[0].n, 'no redundant versions cut');
    assert.equal(purgesAfter.rows[0].n, purgesBefore.rows[0].n, 'no redundant purge enqueued');
  }
);

test(
  're-running the plan after apply is a no-op for the migrated stores (idempotent)',
  { skip },
  async () => {
    const plan = await planBaseRebase(store, { baseThemeId: BASE_THEME });
    const themes = plan.targets.map((t) => t.themeId);
    assert.ok(!themes.includes(CLEAN_THEME), 'migrated clean store no longer behind');
    assert.ok(!themes.includes(NOS_THEME), 'migrated no-shadow store no longer behind');
    // The blocked stores are still behind — nothing changed them.
    assert.ok(themes.includes(DIRTY_THEME));
    assert.ok(themes.includes(BROKEN_THEME));
  }
);
