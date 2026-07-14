import { pool } from '../shared/db';

// Raised when a write would clobber another tenant's resource (store id or host already
// owned by someone else). Routes map this to HTTP 409 rather than the generic 400.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// Provisioning (crosses tenant boundaries): create a tenant + host mapping + home route
// atomically. A merchant is data: no fork, no server, no deploy. Idempotent FOR THE OWNER
// only — an authenticated create must never overwrite another merchant's store or steal a
// host (the upserts below are guarded by the ownership/claim checks up front).
export async function onboardStore({
  id,
  name,
  host,
  color = '#333333',
  ownerUserId,
}: {
  id?: string;
  name?: string;
  host?: string;
  color?: string;
  ownerUserId?: string;
}): Promise<void> {
  if (!id || !name || !host) {
    throw new Error('onboardStore requires id, name and host');
  }
  host = host.toLowerCase(); // hosts are case-insensitive; store lowercase (M-5)
  // Colour is interpolated into the storefront's CSS — only a hex value may pass (defence
  // in depth behind the admin-api boundary; the render layer also falls back safely).
  if (!/^#[0-9a-f]{3,8}$/i.test(color)) {
    throw new Error('color must be a hex value');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-onboarding an existing id is allowed only for an existing owner (idempotent) or a
    // trusted internal caller with no principal (scripts/seed). An authenticated create
    // must never clobber another merchant's store.
    const existing = await client.query('SELECT 1 FROM tenants WHERE id=$1', [id]);
    if (existing.rowCount && ownerUserId) {
      const owns = await client.query(
        "SELECT 1 FROM memberships WHERE clerk_user_id=$1 AND tenant_id=$2 AND role='owner'",
        [ownerUserId, id]
      );
      if (!owns.rowCount) throw new ConflictError('a store with that id already exists');
    }
    // The host must be unclaimed or already this tenant's — never another tenant's.
    const claimed = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM domains WHERE host=$1',
      [host]
    );
    if (claimed.rowCount && claimed.rows[0].tenant_id !== id) {
      throw new ConflictError('that domain is already connected to another store');
    }
    await client.query(
      'INSERT INTO tenants (id, name, theme) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, theme=EXCLUDED.theme',
      [id, name, JSON.stringify({ color })]
    );
    // Guard the upsert itself (not just the SELECT above): under READ COMMITTED two
    // concurrent onboards for the same host both pass the pre-check, so the reassignment
    // must be conditional. Zero rows back = the host is another tenant's → conflict.
    const dom = await client.query(
      `INSERT INTO domains (host, tenant_id) VALUES ($1,$2)
       ON CONFLICT (host) DO UPDATE SET tenant_id=EXCLUDED.tenant_id
         WHERE domains.tenant_id = EXCLUDED.tenant_id
       RETURNING host`,
      [host, id]
    );
    if (!dom.rowCount) throw new ConflictError('that domain is already connected to another store');
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
    if (ownerUserId) {
      await client.query(
        `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1,$2,'owner')
         ON CONFLICT (clerk_user_id, tenant_id) DO NOTHING`,
        [ownerUserId, id]
      );
    }
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
  removed: { routes: number; domains: number; tenants: number; memberships: number };
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
    // memberships first: it FK-references tenants(id), so it must go before the tenant.
    const memberships = await client.query('DELETE FROM memberships WHERE tenant_id = $1', [id]);
    const routes = await client.query('DELETE FROM routes WHERE tenant_id = $1', [id]);
    const domains = await client.query('DELETE FROM domains WHERE tenant_id = $1', [id]);
    const tenants = await client.query('DELETE FROM tenants WHERE id = $1', [id]);
    const { rows } = await client.query<{ residual: string }>(
      `SELECT (SELECT count(*) FROM tenants WHERE id=$1)
            + (SELECT count(*) FROM domains WHERE tenant_id=$1)
            + (SELECT count(*) FROM routes WHERE tenant_id=$1)
            + (SELECT count(*) FROM memberships WHERE tenant_id=$1) AS residual`,
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
        memberships: memberships.rowCount ?? 0,
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

// Domain management for an existing tenant (custom-domain connect flow). Crosses tenant
// boundaries like the rest of this module; callers pass a tenantId they've authorized.
export async function listDomains(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query<{ host: string }>(
    `SELECT host FROM domains WHERE tenant_id = $1 ORDER BY (host LIKE '%.localhost'), host`,
    [tenantId]
  );
  return rows.map((r) => r.host);
}

// Claim a host for a tenant. A host is single-owner (PK): the upsert only reassigns when
// the row is already this tenant's, so a merchant can never take over a host mapped to
// another store. On a foreign claim the WHERE fails, no row returns, and we reject (409).
export async function addDomain(tenantId: string, host: string): Promise<void> {
  const { rowCount } = await pool.query(
    `INSERT INTO domains (host, tenant_id) VALUES ($1,$2)
     ON CONFLICT (host) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       WHERE domains.tenant_id = EXCLUDED.tenant_id
     RETURNING host`,
    [host, tenantId]
  );
  if (!rowCount) throw new ConflictError('that domain is already connected to another store');
}

export async function removeDomain(tenantId: string, host: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM domains WHERE tenant_id = $1 AND host = $2', [
    tenantId,
    host,
  ]);
  return (rowCount ?? 0) > 0;
}
