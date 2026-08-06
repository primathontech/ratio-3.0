// Onboard a new store in seconds — it's just rows (no repo, no build, no restart).
// usage: tsx scripts/onboard.ts <tenantId> <Name> <host> [hexColor]
import { onboardStore } from '@ratio/data-provisioning';
import { pool } from '@ratio/data-db';
import { PageBuilder, PgPageStore, scaffoldStorefront } from '@ratio/builder-core';
import { defaultRegistry } from '@ratio/builder-registry';
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
  // The page builder is the sole renderer — scaffold the default home + templates so the store
  // renders immediately (mirrors the admin-api onboarding flow).
  const pb = new PageBuilder(new PgPageStore(), defaultRegistry(), {
    invalidateByTags: () => Promise.resolve(),
  });
  await scaffoldStorefront(pb, id, { name });
  console.log(`onboarded "${name}" (${id}) → http://${host}:8080/`);
  console.log('(no restart needed; the edge host-cache TTL is ~5s, so give it a moment)');
  await pool.end();
})().catch((e: unknown) => {
  console.error('onboard failed:', (e as Error).message);
  process.exit(1);
});
