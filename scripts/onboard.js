// Onboard a new store in seconds — it's just rows (no repo, no build, no restart).
// usage: node scripts/onboard.js <tenantId> <Name> <host> [hexColor]
const { onboardStore } = require('../src/onboard');
const { pool } = require('../src/db');

const [, , id, name, host, color = '#333333'] = process.argv;
if (!id || !name || !host) {
  console.error('usage: node scripts/onboard.js <tenantId> <Name> <host> [hexColor]');
  console.error('example: node scripts/onboard.js t_gamma Gamma gamma.localhost "#27ae60"');
  process.exit(1);
}

(async () => {
  await onboardStore({ id, name, host, color });
  console.log(`onboarded "${name}" (${id}) → http://${host}:8080/`);
  console.log('(no restart needed; the edge host-cache TTL is ~5s, so give it a moment)');
  await pool.end();
})().catch((e) => {
  console.error('onboard failed:', e.message);
  process.exit(1);
});
