// Onboard a new store in seconds — it's just rows (no repo, no build, no restart).
// usage: tsx scripts/onboard.ts <tenantId> <Name> <host> [hexColor]
import { onboardStore } from '@ratio/data-provisioning';
import { pool } from '@ratio/data-db';
import { ThemeStore, adoptAndPublishDefaultTheme } from '@ratio/builder-core';
import { S3ObjectStore } from '@ratio/data-objects';
import { configureDbFromEnv } from './db';

configureDbFromEnv();

const [, , id, name, host, color = '#333333'] = process.argv;
if (!id || !name || !host) {
  console.error('usage: tsx scripts/onboard.ts <tenantId> <Name> <host> [hexColor]');
  console.error('example: tsx scripts/onboard.ts t_gamma Gamma gamma.localhost "#27ae60"');
  process.exit(1);
}

(async () => {
  await onboardStore({ id, name, host, color, local: process.env.RATIO_LOCAL === 'true' });
  // Publish + activate the bundle theme so the store renders through the bundle — the single renderer
  // (mirrors the admin-api onboarding flow). Needs BUNDLE_S3_* — skipped with a note in a dev setup
  // that hasn't configured object storage. OFCE-616/618.
  const bucket = process.env.BUNDLE_S3_BUCKET;
  if (bucket) {
    const accessKeyId = process.env.BUNDLE_S3_KEY;
    const secretAccessKey = process.env.BUNDLE_S3_SECRET;
    const store = new ThemeStore(
      new S3ObjectStore({
        bucket,
        region: process.env.BUNDLE_S3_REGION,
        endpoint: process.env.BUNDLE_S3_ENDPOINT,
        credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      })
    );
    await adoptAndPublishDefaultTheme(store, id, `${id}-main`, { compile: (s) => s });
  } else {
    console.log('(no BUNDLE_S3_BUCKET — skipped bundle publish; the store has no live theme yet)');
  }
  console.log(`onboarded "${name}" (${id}) → http://${host}:8080/`);
  console.log('(no restart needed; the edge host-cache TTL is ~5s, so give it a moment)');
  await pool.end();
})().catch((e: unknown) => {
  console.error('onboard failed:', (e as Error).message);
  process.exit(1);
});
