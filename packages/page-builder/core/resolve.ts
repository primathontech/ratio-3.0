// Data-binding resolver (ADR-013 / config-not-data). The renderer's SECOND input: a page declares
// data sources (collection/product references + params); this resolves them ONCE via the external
// CMS (the real BindingResolver wraps the npm package; StubResolver stands in for it) and injects
// the fetched data into each data-backed section's binding namespace before composePage runs.
// composePage stays pure. Each resolved source also yields cache tags (col:*/prod:*) so a CMS
// change can purge exactly the pages that showed it.

import type { PageDoc, DataSource } from './doc';
import type { SectionRegistry } from '@ratio/page-builder-registry/registry';

export interface ResolveContext {
  tenantId: string;
  routeParams?: Record<string, string>; // from the router, e.g. { handle: 'summer' }
}

export interface ResolvedSource {
  value: Record<string, unknown>; // merged into the consuming section's primary binding namespace
  tags: string[]; // surrogate cache tags this data depends on (col:<handle>, prod:<id>)
}

// The seam the origin implements against the CMS npm package. StubResolver is the local stand-in.
export interface BindingResolver {
  fetch(source: DataSource, ctx: ResolveContext): Promise<ResolvedSource>;
}

// Replace {{params.x}} placeholders (deep) in a source's params from the route params.
function interpolate(v: unknown, routeParams: Record<string, string>): unknown {
  if (typeof v === 'string')
    return v.replace(/\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => routeParams[k] ?? '');
  if (Array.isArray(v)) return v.map((x) => interpolate(x, routeParams));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = interpolate(val, routeParams);
    return out;
  }
  return v;
}
export function interpolateParams(
  params: Record<string, unknown>,
  routeParams: Record<string, string>
): Record<string, unknown> {
  return interpolate(params ?? {}, routeParams) as Record<string, unknown>;
}

// Resolve a page's data sources and inject the results into its data-backed sections. Returns a
// render-only copy of the doc (config untouched on disk) plus the union of cache tags. A page with
// no dataSources passes straight through — authored-only pages cost nothing.
export async function resolvePage(
  doc: PageDoc,
  registry: SectionRegistry,
  resolver: BindingResolver,
  ctx: ResolveContext
): Promise<{ doc: PageDoc; tags: string[] }> {
  const sources = doc.dataSources ?? {};
  if (Object.keys(sources).length === 0) return { doc, tags: [] };

  const routeParams = ctx.routeParams ?? {};
  const resolved: Record<string, ResolvedSource> = {};
  const tags: string[] = [];
  for (const [key, src] of Object.entries(sources)) {
    const params = interpolateParams(src.params ?? {}, routeParams);
    const r = await resolver.fetch({ ...src, params }, ctx);
    resolved[key] = r;
    tags.push(...r.tags);
  }

  const sections = doc.sections.map((s) => {
    const key = s.dataSourceKey;
    if (!key || !(key in resolved)) return s;
    // inject into the section's primary data binding (e.g. productGrid → 'grid' → grid.products)
    const binding = registry.get(s.type, s.version)?.bindings?.[0]?.name;
    if (!binding) return s;
    const cur = (s.data[binding] as Record<string, unknown>) ?? {};
    return { ...s, data: { ...s.data, [binding]: { ...cur, ...resolved[key].value } } };
  });

  return { doc: { ...doc, sections }, tags: [...new Set(tags)] };
}

// Local stand-in for the CMS package: deterministic sample data so the whole render + cache + purge
// path runs with no external dependency. Swapping in the real package is a one-file change.
export class StubResolver implements BindingResolver {
  async fetch(source: DataSource): Promise<ResolvedSource> {
    if (source.type === 'collectionByHandles') {
      const handles = (source.params?.handles as string[] | undefined) ?? [];
      const limit = Math.max(1, Math.min(24, Number(source.params?.productLimit ?? 4)));
      const products = Array.from({ length: limit }, (_, i) => ({
        id: `${handles[0] ?? 'demo'}-${i + 1}`,
        title: `Sample product ${i + 1}`,
        href: `/products/sample-${i + 1}`,
        image: '',
        price: 499 + i * 100,
      }));
      return {
        value: { products },
        tags: [...handles.map((h) => `col:${h}`), ...products.map((p) => `prod:${p.id}`)],
      };
    }
    if (source.type === 'product') {
      const handle = String(source.params?.handle ?? 'demo');
      return {
        value: {
          title: `Sample: ${handle}`,
          sku: handle,
          amount: 999,
          description: 'Stub product.',
        },
        tags: [`prod:${handle}`],
      };
    }
    // collections
    const first = Math.max(1, Math.min(50, Number(source.params?.first ?? 10)));
    const collections = Array.from({ length: Math.min(first, 6) }, (_, i) => ({
      handle: `collection-${i + 1}`,
      title: `Collection ${i + 1}`,
    }));
    return { value: { collections }, tags: ['col:*'] };
  }
}
