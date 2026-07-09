// Onboard a new store in seconds — it's just rows (no repo, no build, no restart).
// usage: node scripts/onboard.js <tenantId> <Name> <host> [hexColor]
const { pool } = require('../src/db');

const [, , id, name, host, color = '#333333'] = process.argv;
if (!id || !name || !host) {
  console.error('usage: node scripts/onboard.js <tenantId> <Name> <host> [hexColor]');
  console.error('example: node scripts/onboard.js t_gamma Gamma gamma.localhost "#27ae60"');
  process.exit(1);
}

(async () => {
  await pool.query(
    'INSERT INTO tenants (id, name, theme) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, theme=EXCLUDED.theme',
    [id, name, JSON.stringify({ color })]
  );
  await pool.query(
    'INSERT INTO domains (host, tenant_id) VALUES ($1,$2) ON CONFLICT (host) DO UPDATE SET tenant_id=EXCLUDED.tenant_id',
    [host, id]
  );
  await pool.query(
    `INSERT INTO routes (tenant_id, path, page_type, page_config) VALUES ($1,'/','home',$2)
     ON CONFLICT (tenant_id, path) DO UPDATE SET page_config=EXCLUDED.page_config`,
    [id, JSON.stringify({ title: name + ' Home', body: 'Welcome to ' + name + ' — onboarded as data.' })]
  );
  console.log(`onboarded "${name}" (${id}) → http://${host}:8080/`);
  console.log('(no restart needed; the edge host-cache TTL is ~5s, so give it a moment)');
  await pool.end();
})();
