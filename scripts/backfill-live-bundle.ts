// Backfill (OFCE-616): point every store that has no live bundle theme at a published default bundle,
// so the bundle becomes the single renderer for existing stores too — not just the ones onboarded
// after the onboarding change. Idempotent: only touches tenants with live_theme_id IS NULL, and
// respects any overrides an existing theme row already has (publish freezes what's there).
// usage: tsx scripts/backfill-live-bundle.ts   (needs DATABASE_URL + BUNDLE_S3_* in the env)
import { pool } from '@ratio/data-db';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, adoptAndPublishDefaultTheme } from '@ratio/builder-core';
import { configureDbFromEnv } from './db';

configureDbFromEnv();

const mainThemeId = (tenantId: string) => `${tenantId}-main`;
const identityCompile = <T>(s: T) => s;

function bundleStoreFromEnv() {
  const bucket = process.env.BUNDLE_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      'set BUNDLE_S3_BUCKET (+ BUNDLE_S3_ENDPOINT/KEY/SECRET) to backfill bundle themes'
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
  // Exclude the system library tenant — it owns base themes and is never a live storefront.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE live_theme_id IS NULL AND id <> '_library' ORDER BY id"
  );
  console.log(`backfill: ${rows.length} store(s) with no live bundle theme`);
  let ok = 0;
  for (const { id } of rows) {
    try {
      const { version } = await adoptAndPublishDefaultTheme(store, id, mainThemeId(id), {
        compile: identityCompile,
      });
      ok++;
      console.log(`  ✓ ${id} → v${version}`);
    } catch (e) {
      console.error(`  ✗ ${id}:`, (e as Error).message);
    }
  }
  console.log(`backfill done: ${ok}/${rows.length} store(s) now render the bundle theme`);
  await pool.end();
})().catch((e: unknown) => {
  console.error('backfill failed:', (e as Error).message);
  process.exit(1);
});
