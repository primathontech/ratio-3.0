// Sandboxed LiquidJS engine for section/page rendering (D33). Two trust tiers share this factory:
//   - first-party sections: trusted authors, may use registered partials + the full filter set
//   - merchant/app custom sections: untrusted — no filesystem, no dynamic includes, curated
//     filters only, hard resource limits, and (via isolate.ts) a worker-thread wall-clock kill.
//
// The engine ALONE does not make untrusted code safe on compute — no engine self-bounds CPU
// (B1). Limits here are the cooperative first layer; isolate.ts is the hard enforcement. The
// language surface (Liquid) removes the prototype-escape class; that's why Liquid, not Handlebars.

import { Liquid } from 'liquidjs';
import { createHash } from 'node:crypto';

export interface EngineLimits {
  renderLimit: number; // ms of render CPU before Liquid aborts
  memoryLimit: number; // bytes of intermediate output before Liquid aborts
  parseLimit: number; // bytes of template source
}

// Conservative defaults for untrusted merchant templates. Tune from real render telemetry.
export const UNTRUSTED_LIMITS: EngineLimits = {
  renderLimit: 100,
  memoryLimit: 8 * 1024 * 1024, // 8 MB of output
  parseLimit: 64 * 1024, // 64 KB of template source
};

// A filter's cacheability tier — feeds inference (cacheability/infer.ts). A filter that reads
// ambient state (time, randomness, locale) forces the field OFF the `static` tier.
export type FilterTier = 'static' | 'per-request' | 'per-locale';

// The ONLY filters an untrusted template may use. strictFilters:true makes any other filter a
// hard error at parse/render — so this allowlist is enforced, not advisory. Each maps to a tier.
export const FILTER_ALLOWLIST: Record<string, FilterTier> = {
  // pure string/number/array transforms — safe + static
  upcase: 'static',
  downcase: 'static',
  capitalize: 'static',
  strip: 'static',
  truncate: 'static',
  truncatewords: 'static',
  escape: 'static',
  default: 'static',
  size: 'static',
  first: 'static',
  last: 'static',
  join: 'static',
  round: 'static',
  plus: 'static',
  minus: 'static',
  times: 'static',
  divided_by: 'static',
  append: 'static',
  prepend: 'static',
  replace: 'static',
  // locale/currency formatting — output varies by locale/currency dimension
  money: 'per-locale',
  // time — per-request, breaks purity; allowed but forces dynamic tier
  date: 'per-request',
};

export interface EngineOptions {
  trusted: boolean;
  limits?: EngineLimits;
  // first-party partials available to {% render %} (trusted only). Untrusted gets none.
  partials?: Record<string, string>;
}

function buildEngine(opts: EngineOptions): Liquid {
  const limits = opts.limits ?? UNTRUSTED_LIMITS;
  const engine = new Liquid({
    strictFilters: true, // unknown filter = error → enforces the allowlist
    strictVariables: false, // undefined var = '' (inference catches undeclared reads separately)
    renderLimit: limits.renderLimit,
    memoryLimit: limits.memoryLimit,
    parseLimit: limits.parseLimit,
    // no `root`/`fs` → the filesystem loader is never used; {% render %} can only hit the
    // in-memory partial map below. Untrusted templates get an empty map → includes fail closed.
    dynamicPartials: false, // partial names must be string literals, not expressions
  });

  // Register our own `money` filter (LiquidJS has no built-in). Locale/currency-aware → per-locale.
  engine.registerFilter('money', (v: unknown) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return '';
    return '₹' + n.toFixed(2);
  });

  // For untrusted templates, strip every filter that is not on the allowlist. LiquidJS registers
  // its built-ins on construction; we remove the rest so strictFilters rejects them.
  if (!opts.trusted) {
    const registered = (engine.filters as unknown as Map<string, unknown>) ?? null;
    if (registered && typeof registered.forEach === 'function') {
      const toDelete: string[] = [];
      registered.forEach((_v, name) => {
        if (!(name in FILTER_ALLOWLIST)) toDelete.push(name);
      });
      for (const name of toDelete) registered.delete(name);
    }
  }

  return engine;
}

// A cached compiled template. Keyed by (trusted, source-hash) so a given template compiles once.
interface Compiled {
  engine: Liquid;
  templates: ReturnType<Liquid['parse']>;
}
const cache = new Map<string, Compiled>();

function key(trusted: boolean, source: string): string {
  return (trusted ? 't:' : 'u:') + createHash('sha256').update(source).digest('hex');
}

// Compile once, reuse. Parse errors (bad syntax, disallowed filter, oversized source) throw here.
export function compile(source: string, opts: EngineOptions): Compiled {
  const k = key(opts.trusted, source);
  const hit = cache.get(k);
  if (hit) return hit;
  const engine = buildEngine(opts);
  const templates = engine.parse(source); // throws on parse-time violations
  const compiled = { engine, templates };
  cache.set(k, compiled);
  return compiled;
}

// Render a compiled template with a data context. This is the IN-PROCESS render — safe only with
// the cooperative limits above. Untrusted templates MUST go through isolate.ts, which calls this
// inside a worker thread with a hard wall-clock kill. Returns HTML or throws.
export async function render(
  source: string,
  data: Record<string, unknown>,
  opts: EngineOptions
): Promise<string> {
  const { engine, templates } = compile(source, opts);
  return engine.render(templates, data);
}

export function clearCache(): void {
  cache.clear();
}
