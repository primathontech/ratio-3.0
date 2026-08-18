// Rebase stores pinned to an OLDER library-default base version onto the LATEST, so they pick up the
// current default theme. base ⊕ overrides is preserved — a store's own customizations still win; only
// the untouched base files change. Republishes each live theme so the change reaches the storefront.
//
// DRY-RUN by default (reports what would change). Pass --apply to execute. Needs DATABASE_URL +
// BUNDLE_S3_* (base URLs, the same object store the origin/admin-api use).
//   tsx scripts/rebase-to-latest-base.ts            # dry-run
//   tsx scripts/rebase-to-latest-base.ts --apply    # execute
import { pool } from '@ratio/data-db';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, DEFAULT_BASE_THEME_ID } from '@ratio/builder-core';
import { configureDbFromEnv } from './db';

configureDbFromEnv();
const APPLY = process.argv.includes('--apply');
const identity = <T>(s: T) => s;

function bundleStoreFromEnv() {
  const bucket = process.env.BUNDLE_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      'set BUNDLE_S3_BUCKET (+ BUNDLE_S3_ENDPOINT/KEY/SECRET) to rebase bundle themes'
    );
  }
  const accessKeyId = process.env.BUNDLE_S3_KEY;
  const secretAccessKey = process.env.BUNDLE_S3_SECRET;
  return {
    bucket,
    region: process.env.BUNDLE_S3_REGION,
    endpoint: process.env.BUNDLE_S3_ENDPOINT,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  };
}

(async () => {
  const store = new ThemeStore(new S3ObjectStore(bundleStoreFromEnv()));

  const latest = (
    await pool.query<{ v: number }>(
      'SELECT MAX(version)::int AS v FROM theme_bundle_version WHERE theme_id = $1',
      [DEFAULT_BASE_THEME_ID]
    )
  ).rows[0]?.v;
  if (!latest) {
    console.log(`no published ${DEFAULT_BASE_THEME_ID} versions — nothing to do`);
    await pool.end();
    return;
  }
  console.log(`latest ${DEFAULT_BASE_THEME_ID}: v${latest}`);

  // Every non-library theme pinned to an OLDER base version.
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    base_version: number;
    name: string;
    live_theme_id: string | null;
  }>(
    `SELECT th.id, th.tenant_id, th.base_version, ten.name, ten.live_theme_id
       FROM theme th JOIN tenants ten ON ten.id = th.tenant_id
      WHERE th.base_theme_id = $1 AND th.base_version < $2 AND th.tenant_id <> '_library'
      ORDER BY th.tenant_id`,
    [DEFAULT_BASE_THEME_ID, latest]
  );
  console.log(
    `${rows.length} theme(s) on an older base${APPLY ? ' — applying' : ' (DRY-RUN; pass --apply to execute)'}`
  );

  let ok = 0;
  const failures: { id: string; name: string; isLive: boolean; reason: string }[] = [];
  for (const r of rows) {
    // Whole iteration guarded so one store's failure (an S3 read, a publish error) never aborts the
    // run — including dry-run, where a readDraft error would otherwise kill the loop.
    try {
      const overrides = await store.readDraft({ themeId: r.id, tenantId: r.tenant_id });
      const overrideCount = Object.keys(overrides).filter((k) => k !== '_deletes').length;
      const isLive = r.live_theme_id === r.id;
      const label = `  ${r.name} (${r.id}): v${r.base_version} → v${latest} · ${overrideCount} override(s) · ${isLive ? 'live' : 'not-live'}`;
      if (!APPLY) {
        console.log(label);
        continue;
      }
      // Bump the base pin + republish base@latest ⊕ overrides via the tested primitive: it moves the
      // live pointer only for the store's live theme (never hijack a store that activated another
      // theme), and restores the pin on failure so a re-run retries this store rather than skipping it
      // forever as 'already latest' (base_version is the idempotency marker).
      const { version, madeLive } = await store.rebaseToBase(r.tenant_id, r.id, {
        compile: identity,
        toVersion: latest,
      });
      ok++;
      console.log(`${label} → v${version}${madeLive ? ' (live)' : ''} ✓`);
    } catch (e) {
      const reason = (e as Error).message;
      failures.push({ id: r.id, name: r.name, isLive: r.live_theme_id === r.id, reason });
      console.error(`  ${r.name} (${r.id}): FAILED — ${reason}`);
    }
  }
  if (APPLY) {
    console.log(`rebased ${ok}/${rows.length}`);
    if (failures.length) {
      console.error(`\n${failures.length} store(s) could NOT be rebased:`);
      for (const f of failures) {
        const dirty = /unpublished draft/i.test(f.reason);
        const tags =
          (f.isLive ? ' [LIVE]' : '') +
          (dirty ? ' [dirty draft → publish or reset the draft, then re-run]' : '');
        console.error(`  - ${f.name} (${f.id})${tags}: ${f.reason}`);
      }
      const liveFails = failures.filter((f) => f.isLive).length;
      if (liveFails)
        console.error(
          `\n⚠️  ${liveFails} of these are LIVE. Under full theme ownership (OFCE-641) an un-rebased ` +
            `body-only store FAILS LOUD (500) after deploy — resolve these BEFORE the cutover.`
        );
      process.exitCode = 1; // non-zero so ops/CI notices unfinished migration
    }
  }
  await pool.end();
})().catch((e: unknown) => {
  console.error('rebase failed:', (e as Error).message);
  process.exit(1);
});
