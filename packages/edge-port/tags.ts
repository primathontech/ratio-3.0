// Cache-tag scheme (D38). Purge-by-tag is THE invalidation mechanism under Akamai — the version
// pointer is optional now (MOM 2026-07-22). Two tag granularities:
//   - page tag:   one page changed  → purge exactly that page's cached variants
//   - tenant tag: theme-wide change → purge every page of ONE tenant (never neighbours)
// Tags must be deterministic from (tenant, canonical path) so the publish path can name them
// without consulting the cache. Akamai tag charset is restrictive → encode the path.

export function tenantTag(tenantId: string): string {
  return `t.${encodeURIComponent(tenantId)}`;
}

export function pageTag(tenantId: string, canonicalPath: string): string {
  return `p.${encodeURIComponent(tenantId)}.${encodeURIComponent(canonicalPath)}`;
}
