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

// Tenant hard-delete (ADR-010 D-SEC4): purge the tenant's data, then a verification
// pass asserts zero residual — "provably complete" is part of the op, not a hope.
// Today that's DB (routes + domain + tenant); cache/blob/secret purge joins here
// when those layers exist. Atomic + idempotent.
async function deleteStore(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('deleteStore requires a tenant id');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const routes = await client.query('DELETE FROM routes WHERE tenant_id = $1', [id]);
    const domains = await client.query('DELETE FROM domains WHERE tenant_id = $1', [id]);
    const tenants = await client.query('DELETE FROM tenants WHERE id = $1', [id]);
    const { rows } = await client.query(
      `SELECT (SELECT count(*) FROM tenants WHERE id=$1)
            + (SELECT count(*) FROM domains WHERE tenant_id=$1)
            + (SELECT count(*) FROM routes WHERE tenant_id=$1) AS residual`,
      [id]
    );
    const residual = Number(rows[0].residual);
    if (residual !== 0) throw new Error('hard-delete incomplete: residual=' + residual);
    await client.query('COMMIT');
    return {
      deleted: tenants.rowCount > 0,
      removed: { routes: routes.rowCount, domains: domains.rowCount, tenants: tenants.rowCount },
      residual,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { onboardStore, deleteStore };
