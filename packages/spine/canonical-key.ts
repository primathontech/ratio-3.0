// Canonical cache key (P9). The key must:
//  - collapse requests that produce identical output (query order, tracking params, trailing slash)
//  - separate requests whose output differs (allowlisted query params, locale, currency, segment, host alias)
//  - and — critically — the SAME canonicalization must feed the origin render, so a discarded query
//    param cannot secretly change the rendered page (else two "equivalent" keys map to different HTML).

// Params that are allowed to vary output. Everything else (utm_*, fbclid, gclid, ...) is dropped.
const OUTPUT_AFFECTING = new Set(['sort', 'page', 'filter', 'q']);

export interface KeyDims {
  tenantId: string;
  release: string | number;
  path: string;
  query: string; // canonicalized query string ('' if none)
  segment: string; // 'default' today
  locale: string; // 'default' today
  currency: string; // 'default' today
}

// Normalize a path: decode, collapse double slashes, strip a single trailing slash (except root).
export function canonicalPath(rawPath: string): string {
  let p = rawPath;
  try {
    p = decodeURI(p);
  } catch {
    /* leave as-is if malformed */
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

// Canonicalize the query: keep only output-affecting params, sort by key then value, re-encode.
export function canonicalQuery(search: string): string {
  const sp = new URLSearchParams(search);
  const kept: [string, string][] = [];
  for (const [k, v] of sp) if (OUTPUT_AFFECTING.has(k)) kept.push([k, v]);
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return kept.map(([k, v]) => `${k}=${v}`).join('&');
}

export function keyDims(
  tenantId: string,
  release: string | number,
  url: URL,
  opts?: { segment?: string; locale?: string; currency?: string }
): KeyDims {
  return {
    tenantId,
    release,
    path: canonicalPath(url.pathname),
    query: canonicalQuery(url.search),
    segment: opts?.segment ?? 'default',
    locale: opts?.locale ?? 'default',
    currency: opts?.currency ?? 'default',
  };
}

// The string key used for Cache API + R2. Deterministic, collision-free across dims.
export function cacheKey(d: KeyDims): string {
  return [d.tenantId, d.release, d.path, d.query, d.segment, d.locale, d.currency]
    .map((s) => encodeURIComponent(String(s)))
    .join('|');
}

// R2 object key for a release's materialized response. Same dims minus nothing — one object per
// (tenant, release, canonical request).
export function r2Key(d: KeyDims): string {
  return `r2/${cacheKey(d)}`;
}
