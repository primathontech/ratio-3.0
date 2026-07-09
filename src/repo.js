const { pool } = require('./db');

// THE ONE GATE (ADR-001 D-MT3).
// The only way to touch tenant data is through forTenant(tenantId).
// Every query injects tenant_id from here — a caller CANNOT express a query
// without a tenantId, and forTenant(undefined) throws (deny-by-default).
function forTenant(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('DENY: tenant-scoped repository requires a tenantId');
  }
  return {
    async getTenant() {
      const { rows } = await pool.query(
        'SELECT id, name, status, theme FROM tenants WHERE id = $1',
        [tenantId]
      );
      return rows[0] || null;
    },
    async getRoute(path) {
      const { rows } = await pool.query(
        'SELECT tenant_id, path, page_type, page_config FROM routes WHERE tenant_id = $1 AND path = $2',
        [tenantId, path] // tenant_id is ALWAYS the first predicate; caller can't omit it
      );
      return rows[0] || null;
    },
    async addRoute(path, pageType, pageConfig) {
      await pool.query(
        `INSERT INTO routes (tenant_id, path, page_type, page_config)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, path) DO UPDATE SET page_config = EXCLUDED.page_config`,
        [tenantId, path, pageType, JSON.stringify(pageConfig)]
      );
    },
  };
}

module.exports = { forTenant };
