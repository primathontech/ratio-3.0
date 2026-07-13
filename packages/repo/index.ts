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
        'SELECT tenant_id, path, page_type, page_config FROM routes WHERE tenant_id = $1 AND path = $2',
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
    async addRoute(path: string, pageType: string, pageConfig: unknown): Promise<void> {
      await pool.query(
        `INSERT INTO routes (tenant_id, path, page_type, page_config)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, path) DO UPDATE SET page_config = EXCLUDED.page_config`,
        [tenantId, path, pageType, JSON.stringify(pageConfig)]
      );
    },
  };
}
