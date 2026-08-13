import { pool } from '@ratio/data-db';

export interface TenantCommerce {
  merchantId: string;
  storeId?: string; // defaults to merchantId
}
// Merchant storefront theme — global style knobs (see storefront.ts ThemeTokens). All optional,
// all off a fixed scale except the free-form brand colour.
export interface TenantTheme {
  color?: string;
  bodyFont?: string;
  headingFont?: string;
  baseSize?: string;
  radius?: string;
  container?: string;
}
export interface Tenant {
  id: string;
  name: string;
  status: string;
  theme: TenantTheme;
  commerce?: TenantCommerce | null; // per-merchant data-layer config (null until connected)
  // Live bundle-theme pointer (BC1). Null until the store publishes a bundle theme; when set, the
  // origin renders via the compiled bundle for that version instead of the legacy page store.
  liveThemeId?: string | null;
  liveThemeVersion?: number | null;
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
        `SELECT id, name, status, theme, commerce,
                live_theme_id AS "liveThemeId", live_theme_version AS "liveThemeVersion"
           FROM tenants WHERE id = $1`,
        [tenantId]
      );
      return rows[0] || null;
    },
    async setTheme(theme: TenantTheme): Promise<void> {
      await pool.query('UPDATE tenants SET theme = $2 WHERE id = $1', [
        tenantId,
        JSON.stringify(theme),
      ]);
    },
    // Connect (or disconnect, with null) the store's commerce backend. `commerce` carries the
    // GoKwik merchant id that powers products/collections/cart/checkout.
    async setCommerce(commerce: TenantCommerce | null): Promise<void> {
      await pool.query('UPDATE tenants SET commerce = $2 WHERE id = $1', [
        tenantId,
        commerce ? JSON.stringify(commerce) : null,
      ]);
    },
  };
}
