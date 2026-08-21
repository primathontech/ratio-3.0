// Dev/ops: re-publish every library base theme from the CURRENT code files as a NEW version.
//
// Theme SOURCE changes (assets/base.css, sections/*.liquid, …) do NOT reach an already-seeded base —
// once a base has a published version it is frozen and never republished from code (base-library.ts,
// the no-clobber guarantee that protects admin edits). This script is the explicit escape hatch: it
// cuts a fresh version of every base from the current code, so a source change actually lands on the
// base. It also repopulates the object store after a bucket wipe (it re-writes the base bytes).
//
// It does NOT touch stores — after republishing, roll the new base out with the propagation console or
// `scripts/rebase-to-latest-base.ts --apply`. Because it overwrites the base DRAFT, it CLOBBERS any
// admin edits to a base's draft, so it is --apply-gated (never run implicitly).
//
//   tsx scripts/republish-base.ts           # dry-run: show each base's current version
//   tsx scripts/republish-base.ts --apply   # cut a new version of every base from code
// Needs DATABASE_URL + BUNDLE_S3_* (the same object store the origin/admin-api use).
import { pool } from '@ratio/data-db';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, BASE_THEMES, LIBRARY_TENANT_ID } from '@ratio/builder-core';
import { configureDbFromEnv } from './db';

configureDbFromEnv();
const APPLY = process.argv.includes('--apply');
const identity = <T>(s: T) => s;

function bundleStoreFromEnv() {
  const bucket = process.env.BUNDLE_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      'set BUNDLE_S3_BUCKET (+ BUNDLE_S3_ENDPOINT/KEY/SECRET) to republish base themes'
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
  for (const base of BASE_THEMES) {
    const ref = { themeId: base.id, tenantId: LIBRARY_TENANT_ID };
    const current =
      (
        await pool.query<{ v: number }>(
          'SELECT MAX(version)::int AS v FROM theme_bundle_version WHERE theme_id = $1',
          [base.id]
        )
      ).rows[0]?.v ?? 0;
    if (!APPLY) {
      console.log(
        `[dry-run] ${base.id} (${base.name}): current v${current} → would publish v${current + 1} from code`
      );
      continue;
    }
    await store.ensureTheme(LIBRARY_TENANT_ID, base.id, base.name);
    await store.saveDraft(ref, base.files()); // unconditional: replace the base draft with the code files
    const { version } = await store.publish(ref, { compile: identity, makeLive: false });
    console.log(`✓ ${base.id} (${base.name}): published v${version} from code`);
  }
  if (!APPLY) {
    console.log(
      '\ndry-run — pass --apply to publish. Then roll it out to stores:\n  tsx scripts/rebase-to-latest-base.ts --apply'
    );
  }
  await pool.end();
})().catch((e: unknown) => {
  console.error('republish-base failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
