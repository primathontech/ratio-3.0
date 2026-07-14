import { pool } from '../shared/db';

// Platform hosts are ours (wildcard DNS/TLS), so a claim on one is verified immediately.
// Custom domains must prove ownership via Cloudflare DV before their claim is authoritative.
const isPlatformHost = (host: string) =>
  host.endsWith('.ratiodev.in') || host.endsWith('.localhost');

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
}): Promise<{ hostReclaimedFrom: string | null }> {
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
    // The host must be unclaimed, already this tenant's, or a still-unverified claim by another
    // tenant (reclaimable). A verified claim by someone else is protected (H1).
    const claimed = await client.query<{ tenant_id: string; verified: boolean }>(
      'SELECT tenant_id, verified FROM domains WHERE host=$1',
      [host]
    );
    if (claimed.rowCount && claimed.rows[0].tenant_id !== id && claimed.rows[0].verified) {
      throw new ConflictError('that domain is already connected to another store');
    }
    // A cross-tenant reclaim of an unverified host: the caller must clean up the prior tenant's
    // stale CF custom hostname so this claimant can run their own DV (OFCE-422).
    const hostReclaimedFrom =
      claimed.rowCount && claimed.rows[0].tenant_id !== id ? claimed.rows[0].tenant_id : null;
    await client.query(
      'INSERT INTO tenants (id, name, theme) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, theme=EXCLUDED.theme',
      [id, name, JSON.stringify({ color })]
    );
    // Guard the upsert itself (not just the SELECT above): under READ COMMITTED two
    // concurrent onboards for the same host both pass the pre-check, so the reassignment
    // must be conditional. Zero rows back = the host is another tenant's → conflict.
    const dom = await client.query(
      `INSERT INTO domains (host, tenant_id, verified, connected_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (host) DO UPDATE SET
           tenant_id    = EXCLUDED.tenant_id,
           verified     = domains.verified OR EXCLUDED.verified,
           -- keep the connector on a same-tenant re-onboard; reset it on a cross-tenant
           -- reclaim so the new holder can't inherit the prior tenant's verification (R10-H1)
           connected_by = CASE WHEN domains.tenant_id = EXCLUDED.tenant_id
                               THEN domains.connected_by ELSE EXCLUDED.connected_by END
         WHERE domains.tenant_id = EXCLUDED.tenant_id OR domains.verified = false
       RETURNING host`,
      [host, id, isPlatformHost(host), isPlatformHost(host) ? id : null]
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
    return { hostReclaimedFrom };
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
export async function addDomain(
  tenantId: string,
  host: string
): Promise<{ reclaimedFrom: string | null }> {
  const prior = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM domains WHERE host = $1',
    [host]
  );
  // Reassign only when the row is already this tenant's OR the existing claim is still
  // unverified (reclaimable). A verified claim by another tenant is protected → 0 rows → 409.
  const { rowCount } = await pool.query(
    `INSERT INTO domains (host, tenant_id, verified, connected_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (host) DO UPDATE SET
         tenant_id    = EXCLUDED.tenant_id,
         verified     = domains.verified OR EXCLUDED.verified,
         -- reset the connector on a cross-tenant reclaim (R10-H1); keep it on a same-tenant re-add
         connected_by = CASE WHEN domains.tenant_id = EXCLUDED.tenant_id
                             THEN domains.connected_by ELSE EXCLUDED.connected_by END
       WHERE domains.tenant_id = EXCLUDED.tenant_id OR domains.verified = false
     RETURNING host`,
    [host, tenantId, isPlatformHost(host), isPlatformHost(host) ? tenantId : null]
  );
  if (!rowCount) throw new ConflictError('that domain is already connected to another store');
  return {
    reclaimedFrom:
      prior.rowCount && prior.rows[0].tenant_id !== tenantId ? prior.rows[0].tenant_id : null,
  };
}

// Record that THIS tenant initiated the connect/DV flow for a host (they created the CF custom
// hostname). Only the connector can later be promoted to verified (R10-H1). No-op if the tenant
// no longer holds the row.
export async function markDomainConnected(tenantId: string, host: string): Promise<void> {
  await pool.query('UPDATE domains SET connected_by = $1 WHERE tenant_id = $1 AND host = $2', [
    tenantId,
    host,
  ]);
}

// Mark a custom-domain claim authoritative once Cloudflare confirms the hostname is active
// (DV succeeded). Bound to the connector (R10-H1): a tenant that merely reclaimed the row —
// without running its own connect — is NOT its connector, so it can't inherit the prior
// holder's DV. Idempotent; only ever flips false → true.
export async function markDomainVerified(tenantId: string, host: string): Promise<void> {
  await pool.query(
    'UPDATE domains SET verified = true WHERE tenant_id = $1 AND host = $2 AND connected_by = $1',
    [tenantId, host]
  );
}

export async function removeDomain(tenantId: string, host: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM domains WHERE tenant_id = $1 AND host = $2', [
    tenantId,
    host,
  ]);
  return (rowCount ?? 0) > 0;
}
