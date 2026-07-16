// Shared response helpers — sanitize + checksum. Lives here (not in publisher.ts) so both the
// publisher and the edge import it without a cycle.

import { createHash } from 'node:crypto';
import type { StoredResponse } from './stores';

export function checksum(r: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): string {
  const h = createHash('sha256');
  h.update(String(r.status));
  h.update(JSON.stringify(r.headers));
  h.update(r.body);
  return h.digest('hex');
}

// Headers that must never enter shared storage (P10). Everything not on the allowlist is dropped.
const CACHEABLE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-language',
  'location',
  'x-page-type',
]);

export function sanitizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'set-cookie') continue; // never
    if (CACHEABLE_HEADER_ALLOWLIST.has(lk)) out[lk] = v;
  }
  return out;
}

export function toStored(r: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): StoredResponse {
  const clean = { status: r.status, headers: sanitizeHeaders(r.headers), body: r.body };
  return { ...clean, checksum: checksum(clean) };
}
