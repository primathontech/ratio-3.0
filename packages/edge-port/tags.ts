// Cache-tag scheme (D38). Purge-by-tag is THE invalidation mechanism under Akamai — the version
// pointer is optional now (MOM 2026-07-22). Two tag granularities:
//   - page tag:   one page changed  → purge exactly that page's cached variants
//   - tenant tag: theme-wide change → purge every page of ONE tenant (never neighbours)
//
// Akamai cache-tag constraints are the design driver here: tags over 128 chars DO NOT PURGE
// (silently — and under our year-long shell TTL, an unpurgeable page is stale forever), and the
// charset is restricted. So the path segment is a fixed-length hash, never an encoding of the
// path: deterministic, always 24 chars, always [0-9a-f]. Tenant ids are platform-generated and
// already safe; anything unexpected gets hashed too rather than trusted.

import { createHash } from 'node:crypto';

const SAFE_SEG = /^[A-Za-z0-9_-]{1,40}$/;

const hash = (s: string, len: number) => createHash('sha256').update(s).digest('hex').slice(0, len);

function seg(s: string): string {
  return SAFE_SEG.test(s) ? s : hash(s, 16);
}

// worst case: "t." + 40 = 42 chars — far inside the 128 limit
export function tenantTag(tenantId: string): string {
  return `t.${seg(tenantId)}`;
}

// worst case: "p." + 40 + "." + 24 = 67 chars
export function pageTag(tenantId: string, canonicalPath: string): string {
  return `p.${seg(tenantId)}.${hash(canonicalPath, 24)}`;
}
