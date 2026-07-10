const { pool } = require('./db');

// Provisioning (crosses tenant boundaries, so NOT a forTenant op): create a tenant,
// its host→tenant mapping, and an initial home route — atomically, in one transaction.
// A merchant is data: no fork, no server, no deploy. Idempotent (re-onboard = update).
async function onboardStore({ id, name, host, color = '#333333' }) {
  if (!id || !name || !host) {
    throw new Error('onboardStore requires id, name and host');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO tenants (id, name, theme) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, theme=EXCLUDED.theme',
      [id, name, JSON.stringify({ color })]
    );
    await client.query(
      'INSERT INTO domains (host, tenant_id) VALUES ($1,$2) ON CONFLICT (host) DO UPDATE SET tenant_id=EXCLUDED.tenant_id',
      [host, id]
    );
    await client.query(
      `INSERT INTO routes (tenant_id, path, page_type, page_config) VALUES ($1,'/','home',$2)
       ON CONFLICT (tenant_id, path) DO UPDATE SET page_config=EXCLUDED.page_config`,
      [id, JSON.stringify({ title: name + ' Home', body: 'Welcome to ' + name + ' — onboarded as data.' })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { onboardStore };
