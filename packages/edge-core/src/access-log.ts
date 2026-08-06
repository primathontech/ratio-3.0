// S4 D-R8 (observability): one structured, tenant-scoped access record per request, emitted to the
// edge log sink. The record is a FIXED field allowlist — header values, cookies, secrets, and the
// query string (which can carry tokens/PII) can never enter it by construction. This alone yields
// per-tenant error rate, stale-serve rate (a cache-health proxy), and edge latency without any new
// infra. On Akamai the same records go to DataStream 2 instead of Workers Logs.
export interface AccessLog {
  t: 'access';
  tenant: string | null;
  method: string;
  path: string;
  status: number;
  stale: boolean;
  ms: number;
}
export function buildAccessLog(input: {
  tenantId: string | null;
  method: string;
  url: string;
  status: number;
  stale: boolean;
  ms: number;
}): AccessLog {
  return {
    t: 'access',
    tenant: input.tenantId,
    method: input.method,
    path: new URL(input.url).pathname, // pathname only — never the query string
    status: input.status,
    stale: input.stale,
    ms: Math.round(input.ms),
  };
}
export function logAccess(record: AccessLog): void {
  // Structured JSON to the edge log sink — this is the logger, not stray debug output.
  console.log(JSON.stringify(record));
}

// Durable metrics sink. On Cloudflare this is Workers Analytics Engine (queryable outside the
// isolate). Minimal local interface (matches the TenantKV / EdgeCache style) so we don't depend on
// the full workers-types.
export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}
export function buildMetricPoint(input: {
  tenantId: string | null;
  path: string;
  status: number;
  stale: boolean;
  ms: number;
}): { blobs: string[]; doubles: number[]; indexes: string[] } {
  const tenant = input.tenantId ?? '_none';
  return {
    // Exactly one index = the sampling key. Tenant-bounded so per-tenant cardinality can't explode;
    // AE samples the long tail on its own (ADR-008 D-R8 "top-N + aggregate the long tail").
    indexes: [tenant],
    blobs: [tenant, input.path, input.stale ? 'stale' : 'fresh'],
    doubles: [input.status, Math.round(input.ms), input.stale ? 1 : 0],
  };
}
