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
    base_version: number;
    name: string;
    live_theme_id: string | null;
  }>(
    `SELECT th.id, th.base_version, ten.name, ten.live_theme_id
       FROM theme th JOIN tenants ten ON ten.id = th.tenant_id
      WHERE th.base_theme_id = $1 AND th.base_version < $2 AND th.tenant_id <> '_library'
      ORDER BY th.tenant_id`,
    [DEFAULT_BASE_THEME_ID, latest]
  );
  console.log(
    `${rows.length} theme(s) on an older base${APPLY ? ' — applying' : ' (DRY-RUN; pass --apply to execute)'}`
  );

  let ok = 0;
  for (const r of rows) {
    // Whole iteration guarded so one store's failure (an S3 read, a publish error) never aborts the
    // run — including dry-run, where a readDraft error would otherwise kill the loop.
    try {
      const overrides = await store.readDraft({ themeId: r.id });
      const overrideCount = Object.keys(overrides).filter((k) => k !== '_deletes').length;
      const isLive = r.live_theme_id === r.id;
      const label = `  ${r.name} (${r.id}): v${r.base_version} → v${latest} · ${overrideCount} override(s) · ${isLive ? 'live' : 'not-live'}`;
      if (!APPLY) {
        console.log(label);
        continue;
      }
      // Bump the base pin, then republish base@latest ⊕ overrides. If publish fails, put the pin BACK
      // so a re-run RETRIES this store — otherwise it would read as 'already latest' and be skipped
      // forever, with no new version ever cut (base_version alone is the idempotency marker).
      await pool.query('UPDATE theme SET base_version = $2 WHERE id = $1', [r.id, latest]);
      try {
        // Only flip the live pointer for a theme that IS the store's live one — never switch a store
        // that has activated a different theme. The rebase still cuts a version either way.
        const { version } = await store.publish(
          { themeId: r.id },
          { compile: identity, makeLive: isLive }
        );
        ok++;
        console.log(`${label} → v${version} ✓`);
      } catch (e) {
        await pool
          .query('UPDATE theme SET base_version = $2 WHERE id = $1', [r.id, r.base_version])
          .catch(() => {});
        throw e;
      }
    } catch (e) {
      console.error(`  ${r.name} (${r.id}): FAILED — ${(e as Error).message}`);
    }
  }
  if (APPLY) console.log(`rebased ${ok}/${rows.length}`);
  await pool.end();
})().catch((e: unknown) => {
  console.error('rebase failed:', (e as Error).message);
  process.exit(1);
});
