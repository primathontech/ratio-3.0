// Onboard a new store in seconds — it's just rows (no repo, no build, no restart).
// usage: tsx scripts/onboard.ts <tenantId> <Name> <host> [hexColor]
import { onboardStore } from '../src/onboard';
import { pool } from '../src/db';

const [, , id, name, host, color = '#333333'] = process.argv;
if (!id || !name || !host) {
  console.error('usage: tsx scripts/onboard.ts <tenantId> <Name> <host> [hexColor]');
  console.error('example: tsx scripts/onboard.ts t_gamma Gamma gamma.localhost "#27ae60"');
  process.exit(1);
}

(async () => {
  await onboardStore({ id, name, host, color });
  console.log(`onboarded "${name}" (${id}) → http://${host}:8080/`);
  console.log('(no restart needed; the edge host-cache TTL is ~5s, so give it a moment)');
  await pool.end();
})().catch((e: unknown) => {
  console.error('onboard failed:', (e as Error).message);
  process.exit(1);
});
