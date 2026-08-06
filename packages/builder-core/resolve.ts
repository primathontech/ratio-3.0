// Data-binding resolver (ADR-013 / config-not-data). The renderer's SECOND input: a page declares
// data sources (collection/product references + params); this resolves them ONCE via the external
// CMS (the real BindingResolver wraps the npm package; StubResolver stands in for it) and injects
// the fetched data into each data-backed section's binding namespace before composePage runs.
// composePage stays pure. Each resolved source also yields cache tags (col:*/prod:*) so a CMS
// change can purge exactly the pages that showed it.

import type { PageDoc, DataSource } from './doc';
import { DATA_SOURCE_TYPES } from './doc';
import type { SectionRegistry } from '@ratio/builder-registry';

// Per-tenant data-layer config (from the tenant record). storeId defaults to merchantId.
export interface TenantCommerce {
  merchantId: string;
  storeId?: string;
}
export interface ResolveContext {
  tenantId: string;
  routeParams?: Record<string, string>; // from the router, e.g. { handle: 'summer' }
  commerce?: TenantCommerce | null; // the merchant's data-layer identifiers (null = not connected)
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
    const bindings = registry.get(s.type, s.version)?.bindings?.map((b) => b.name) ?? [];
    if (bindings.length === 0) return s;
    // Route each resolved key to a matching binding (e.g. { product, price } → product.*, price.*
    // for a PDP). Keys that aren't a binding go into the PRIMARY one (e.g. { products } → grid).
    const declared = new Set(bindings);
    const data: Record<string, unknown> = { ...s.data };
    const primaryPayload: Record<string, unknown> = {};
    const mergeInto = (name: string, val: unknown) => {
      data[name] = { ...((data[name] as Record<string, unknown>) ?? {}), ...(val as object) };
    };
    for (const [k, v] of Object.entries(resolved[key].value)) {
      if (declared.has(k)) mergeInto(k, v);
      else primaryPayload[k] = v;
    }
    if (Object.keys(primaryPayload).length) mergeInto(bindings[0], primaryPayload);
    return { ...s, data };
  });

  return { doc: { ...doc, sections }, tags: [...new Set(tags)] };
}

// Gokwik-shaped samples (paise, image_url, handle) — the SAME canonical shape the real backend
// returns, so templates behave identically offline. No display transform here (that's the render).
function sampleProducts(seed: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${seed}-${i + 1}`,
    title: `Sample product ${i + 1}`,
    handle: `sample-${i + 1}`,
    price: 49900 + i * 10000, // paise
    image_url: '',
  }));
}

// Local stand-in for @ratio/data-layer: deterministic sample data so the whole render+cache+purge
// path runs with no external dependency. The REAL resolver dispatches the same DATA_SOURCE_TYPES to
// the data-layer CommerceClient — COLLECTION_BY_HANDLES→getCollectionsByHandles, PRODUCT→getProduct,
// COLLECTIONS→getCollections — and maps the response into the section's binding shape. Swapping the
// stub for it is one file.
export class StubResolver implements BindingResolver {
  async fetch(source: DataSource): Promise<ResolvedSource> {
    const p = source.params ?? {};
    const limit = Math.max(1, Math.min(24, Number(p.productLimit ?? p.first ?? 4)));
    switch (source.type) {
      case DATA_SOURCE_TYPES.COLLECTION_BY_HANDLES:
      case DATA_SOURCE_TYPES.COLLECTION: {
        const handles = (p.handles as string[] | undefined) ?? (p.handle ? [String(p.handle)] : []);
        const products = sampleProducts(handles[0] ?? 'demo', limit);
        return {
          value: { products },
          tags: [...handles.map((h) => `col:${h}`), ...products.map((x) => `prod:${x.id}`)],
        };
      }
      case DATA_SOURCE_TYPES.PRODUCTS:
      case DATA_SOURCE_TYPES.PRODUCTS_BY_HANDLES: {
        const products = sampleProducts('demo', limit);
        return { value: { products }, tags: products.map((x) => `prod:${x.id}`) };
      }
      case DATA_SOURCE_TYPES.PRODUCT: {
        const handle = String(p.handle ?? 'demo');
        // flat canonical product → the section's `product` binding (price in paise)
        return {
          value: {
            id: handle,
            title: `Sample: ${handle}`,
            handle,
            price: 99900,
            description: 'Stub product.',
            image_url: '',
          },
          tags: [`prod:${handle}`],
        };
      }
      case DATA_SOURCE_TYPES.COLLECTIONS: {
        const collections = Array.from({ length: Math.min(limit, 6) }, (_, i) => ({
          handle: `collection-${i + 1}`,
          title: `Collection ${i + 1}`,
        }));
        return { value: { collections }, tags: ['col:*'] };
      }
      case DATA_SOURCE_TYPES.STATIC:
        return { value: p, tags: [] }; // inline config, no fetch
      default:
        return { value: {}, tags: [] };
    }
  }
}
