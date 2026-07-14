import { pool } from '../shared/db';

export interface Tenant {
  id: string;
  name: string;
  status: string;
  theme: { color?: string };
}
export interface Route {
  tenant_id: string;
  path: string;
  page_type: string;
  page_config: Record<string, unknown>;
  version: number;
}

// Raised when a page write carries a stale expected version (someone else — a human tab or
// the AI assistant — saved in between). Routes map it to HTTP 409 (OFCE-409).
export class StaleWriteError extends Error {
  constructor(message = 'this page changed since you opened it') {
    super(message);
    this.name = 'StaleWriteError';
  }
}

// THE ONE GATE (ADR-001 D-MT3). The only way to touch tenant data is forTenant(id).
// Every query injects tenant_id here; a caller cannot express a query without one,
// and forTenant without an id throws (deny-by-default).
export function forTenant(tenantId: string) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('DENY: tenant-scoped repository requires a tenantId');
  }
  return {
    async getTenant(): Promise<Tenant | null> {
      const { rows } = await pool.query<Tenant>(
        'SELECT id, name, status, theme FROM tenants WHERE id = $1',
        [tenantId]
      );
      return rows[0] || null;
    },
    async getRoute(path: string): Promise<Route | null> {
      const { rows } = await pool.query<Route>(
        'SELECT tenant_id, path, page_type, page_config, version FROM routes WHERE tenant_id = $1 AND path = $2',
        [tenantId, path]
      );
      return rows[0] || null;
    },
    async listRoutes(): Promise<{ path: string; page_type: string }[]> {
      const { rows } = await pool.query<{ path: string; page_type: string }>(
        'SELECT path, page_type FROM routes WHERE tenant_id = $1 ORDER BY path',
        [tenantId]
      );
      return rows;
    },
    // Upsert a route and return its new version. When expectedVersion is given, the update
    // only applies if the row is still at that version (optimistic concurrency, OFCE-409) —
    // a stale write throws StaleWriteError. Every update bumps version, so a version-aware
    // editor is protected even against callers that omit it (the assistant, seed scripts).
    async addRoute(
      path: string,
      pageType: string,
      pageConfig: unknown,
      expectedVersion?: number
    ): Promise<number> {
      const where = expectedVersion === undefined ? '' : 'WHERE routes.version = $5';
      const params = [tenantId, path, pageType, JSON.stringify(pageConfig)];
      if (expectedVersion !== undefined) params.push(String(expectedVersion));
      const { rows } = await pool.query<{ version: number }>(
        `INSERT INTO routes (tenant_id, path, page_type, page_config, version)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (tenant_id, path) DO UPDATE
           SET page_config = EXCLUDED.page_config, version = routes.version + 1
           ${where}
         RETURNING version`,
        params
      );
      if (rows.length === 0) throw new StaleWriteError();
      return rows[0].version;
    },
  };
}
