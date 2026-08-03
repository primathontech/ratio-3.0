// Cacheability inference (B2, REQ-3). Devs declare NOTHING about cache tier — we COMPUTE it from
// the template. A section's effective tier is the max (most-dynamic) of:
//   1. undeclared data reads      → reject outright (a section may only read its declared bindings)
//   2. the data bindings it reads  → each binding carries a tier (static | shared-volatile | per-user | per-segment)
//   3. the filters it uses         → a time/locale filter forces the field off `static` (FILTER_ALLOWLIST)
//   4. unresolved includes         → reject from the auto-cacheable tier (can't be analyzed)
//
// Uses LiquidJS analyzeSync (globals = out-of-scope reads, locals = assign/capture targets). A
// hand-rolled walker misses dynamic-index, assign-laundering, block bodies — analyzeSync doesn't.

import { Liquid } from 'liquidjs';
import { FILTER_ALLOWLIST, type FilterTier } from './engine';

export type Tier = 'static' | 'shared-volatile' | 'per-segment' | 'per-user';

// tier ordering, least→most dynamic; the effective tier is the max over all inputs.
const ORDER: Tier[] = ['static', 'shared-volatile', 'per-segment', 'per-user'];
function maxTier(a: Tier, b: Tier): Tier {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}
function filterTierToTier(f: FilterTier): Tier {
  return f === 'per-request' ? 'per-user' : f === 'per-locale' ? 'per-segment' : 'static';
}

export interface Binding {
  name: string; // the root variable the template may read, e.g. "product"
  tier: Tier; // its declared cacheability
}

export interface InferenceResult {
  ok: boolean;
  tier: Tier; // effective tier if ok
  undeclared: string[]; // global reads not in the binding set → why it was rejected
  usedFilters: string[]; // filters the template uses (all allowlisted, else compile already threw)
  reasons: string[]; // human-readable trace of what drove the tier
}

const analyzer = new Liquid({ strictFilters: false });

// Extract the filter names a template uses, by scanning the source. analyzeSync surfaces variables
// but not filters, so we scan for `| name` occurrences and validate against the allowlist.
function extractFilters(source: string): string[] {
  const found = new Set<string>();
  const re = /\|\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.add(m[1]);
  return [...found];
}

// Infer a section's cacheability tier from its Liquid source + the bindings it's allowed to read.
// Rejects (ok:false) if it reads anything undeclared, or uses an unresolved include/render.
export function inferTier(source: string, bindings: Binding[]): InferenceResult {
  const reasons: string[] = [];
  const declared = new Map(bindings.map((b) => [b.name, b.tier]));

  // 1. includes/renders FIRST — a partial can't be statically resolved here (no fs, and a dynamic
  //    name is un-analyzable), and analyzeSync would throw on it. Reject from the auto-cacheable tier.
  if (/\{%\s*(render|include)\b/.test(source)) {
    reasons.push(
      'uses render/include — not eligible for auto-cacheability (needs resolver or ban)'
    );
    return { ok: false, tier: 'per-user', undeclared: [], usedFilters: [], reasons };
  }

  // 2. globals = out-of-scope reads. Any global not in the declared binding set = undeclared access.
  const analysis = analyzer.analyzeSync(analyzer.parse(source));
  const globals = Object.keys(analysis.globals);
  const undeclared = globals.filter((g) => !declared.has(g));

  if (undeclared.length) {
    reasons.push(`undeclared data reads: ${undeclared.join(', ')}`);
    return { ok: false, tier: 'per-user', undeclared, usedFilters: [], reasons };
  }

  // 3. start at static; raise by each read binding's tier and each filter's tier.
  let tier: Tier = 'static';
  for (const g of globals) {
    const t = declared.get(g)!;
    tier = maxTier(tier, t);
    if (t !== 'static') reasons.push(`reads ${g} (${t})`);
  }
  const usedFilters = extractFilters(source);
  for (const f of usedFilters) {
    const ft = FILTER_ALLOWLIST[f];
    if (ft) {
      const t = filterTierToTier(ft);
      tier = maxTier(tier, t);
      if (t !== 'static') reasons.push(`uses filter ${f} (${ft})`);
    }
  }
  if (reasons.length === 0) reasons.push('pure static — all reads + filters are static');
  return { ok: true, tier, undeclared: [], usedFilters, reasons };
}
