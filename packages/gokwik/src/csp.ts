import type { CspDirectives } from './types';

// GoKwik serves its widgets from *.gokwik.co, calls its APIs on *.gokwik.io, and pulls its own font
// from Google Fonts. Every GoKwik integration (side-cart, checkout, …) needs these hosts allowed, so
// they share one directive set that the composer merges onto the storefront's strict base.
export const GOKWIK_CSP: CspDirectives = {
  'script-src': ["'self'", "'unsafe-inline'", 'https://*.gokwik.co', 'https://*.gokwik.io'],
  'connect-src': ["'self'", 'https://*.gokwik.co', 'https://*.gokwik.io'],
  'style-src': ['https://fonts.googleapis.com', 'https://*.gokwik.co', 'https://*.gokwik.io'],
  'font-src': ['https://fonts.gstatic.com', 'https://*.gokwik.co', 'https://*.gokwik.io'],
  'frame-src': ['https://*.gokwik.co', 'https://*.gokwik.io'],
};

// Union two CSP directive maps. When a directive gains a real source alongside 'none' (the strict
// default), 'none' is dropped — 'none' means "nothing", so it can't coexist with actual hosts.
export function mergeCsp(base: CspDirectives, add: CspDirectives): CspDirectives {
  const out: CspDirectives = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(add)])) {
    const union = [...new Set([...(base[key] ?? []), ...(add[key] ?? [])])];
    out[key] = union.length > 1 ? union.filter((v) => v !== "'none'") : union;
  }
  return out;
}

export function cspToString(d: CspDirectives): string {
  return Object.entries(d)
    .map(([key, vals]) => `${key} ${vals.join(' ')}`)
    .join('; ');
}
