// ADR-016 Phase 1 (OFCE-401): the control-plane scope catalog — the single source of
// truth for "which permission does this route need." Today it labels audit rows and feeds
// the OpenAPI security model; Phase 2 (OFCE-402) enforces it as `granted ∩ role ∩ tenant`.
// Kept resource:verb so it maps cleanly onto the Ratio dev-app scope model (ADR-016 D-CPA1).

export const SCOPES = {
  STORES_READ: 'stores:read',
  STORES_ONBOARD: 'stores:onboard',
  STORES_DELETE: 'stores:delete',
  PAGES_READ: 'pages:read',
  PAGES_WRITE: 'pages:write',
  DOMAINS_READ: 'domains:read',
  DOMAINS_WRITE: 'domains:write',
  TOKENS_MINT: 'tokens:mint',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

// Keyed by `${METHOD} ${Hono routePath}` — the registered route pattern, not the concrete
// URL, so it's stable regardless of the tenant id in the path.
const ROUTE_SCOPES: Record<string, Scope> = {
  'POST /stores': SCOPES.STORES_ONBOARD,
  'GET /stores/:id': SCOPES.STORES_READ,
  'DELETE /stores/:id': SCOPES.STORES_DELETE,
  'POST /stores/:id/agent-tokens': SCOPES.TOKENS_MINT,
  'GET /stores/:id/pages': SCOPES.PAGES_READ,
  'GET /stores/:id/page': SCOPES.PAGES_READ,
  'PUT /stores/:id/page': SCOPES.PAGES_WRITE,
  'GET /stores/:id/domains': SCOPES.DOMAINS_READ,
  'POST /stores/:id/domains': SCOPES.DOMAINS_WRITE,
  'DELETE /stores/:id/domains': SCOPES.DOMAINS_WRITE,
  'GET /stores/:id/domain': SCOPES.DOMAINS_READ,
};

export function scopeFor(method: string, routePath: string): Scope | null {
  return ROUTE_SCOPES[`${method} ${routePath}`] ?? null;
}
