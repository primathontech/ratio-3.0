import { pool } from './db';

// Provisioning (crosses tenant boundaries): create a tenant + host mapping + home
// route atomically. A merchant is data: no fork, no server, no deploy. Idempotent.
export async function onboardStore({
  id,
  name,
  host,
  color = '#333333',
}: {
  id?: string;
  name?: string;
  host?: string;
  color?: string;
}): Promise<void> {
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
      [
        id,
        JSON.stringify({
          title: name + ' Home',
          body: 'Welcome to ' + name + ' — onboarded as data.',
        }),
      ]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface DeleteProof {
  deleted: boolean;
  removed: { routes: number; domains: number; tenants: number };
  residual: number;
}

// Tenant hard-delete (ADR-010 D-SEC4): purge + an in-txn verification pass asserting
// zero residual. DB-scoped today; cache/blob/secret purge joins here when they exist.
export async function deleteStore(id?: string): Promise<DeleteProof> {
  if (!id || typeof id !== 'string') {
    throw new Error('deleteStore requires a tenant id');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const routes = await client.query('DELETE FROM routes WHERE tenant_id = $1', [id]);
    const domains = await client.query('DELETE FROM domains WHERE tenant_id = $1', [id]);
    const tenants = await client.query('DELETE FROM tenants WHERE id = $1', [id]);
    const { rows } = await client.query<{ residual: string }>(
      `SELECT (SELECT count(*) FROM tenants WHERE id=$1)
            + (SELECT count(*) FROM domains WHERE tenant_id=$1)
            + (SELECT count(*) FROM routes WHERE tenant_id=$1) AS residual`,
      [id]
    );
    const residual = Number(rows[0].residual);
    if (residual !== 0) throw new Error('hard-delete incomplete: residual=' + residual);
    await client.query('COMMIT');
    return {
      deleted: (tenants.rowCount ?? 0) > 0,
      removed: {
        routes: routes.rowCount ?? 0,
        domains: domains.rowCount ?? 0,
        tenants: tenants.rowCount ?? 0,
      },
      residual,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
