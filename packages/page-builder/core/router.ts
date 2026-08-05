// Storefront route table (ADR-013 routing). Ratio 2.0 leaned on Next.js file routing; the 3.0
// origin is a Hono app with no framework router, so this maps a request path to the page TEMPLATE
// to load + the route params the resolver interpolates ({{params.handle}}).
//
// The origin tries an EXACT stored page first (home '/', custom pages like '/about'); this table
// handles the DYNAMIC types where ONE template serves many URLs — a single Collection template
// renders every /collections/:handle, a single Product template every /products/:handle. Both the
// flat and the collection-nested product URL load the same Product template (decision: one template
// per type); the nested form just carries an extra `collection` param for breadcrumbs/back-nav.

export type PageType = 'home' | 'collection' | 'product' | 'page';

export interface RouteMatch {
  templateKey: string; // pages-table key to load (the canonical template path)
  pageType: PageType;
  params: Record<string, string>;
}

interface CompiledRoute {
  pageType: PageType;
  templateKey: string;
  regex: RegExp;
  keys: string[];
}

// `:name` captures one non-empty path segment.
function compile(pageType: PageType, pattern: string, templateKey: string): CompiledRoute {
  const keys: string[] = [];
  const source = pattern.replace(/:[A-Za-z][A-Za-z0-9]*/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { pageType, templateKey, regex: new RegExp(`^${source}$`), keys };
}

// Most specific first (the nested product URL must win over nothing else, but keep it ordered).
const ROUTES: CompiledRoute[] = [
  compile('product', '/collections/:collection/products/:handle', '/products/:handle'),
  compile('collection', '/collections/:handle', '/collections/:handle'),
  compile('product', '/products/:handle', '/products/:handle'),
];

// The canonical template keys dynamic pages are authored + stored under.
export const TEMPLATE_KEYS = ['/collections/:handle', '/products/:handle'] as const;

export function matchRoute(path: string): RouteMatch | null {
  for (const r of ROUTES) {
    const m = r.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      const raw = m[i + 1];
      try {
        params[k] = decodeURIComponent(raw);
      } catch {
        params[k] = raw;
      }
    });
    return { templateKey: r.templateKey, pageType: r.pageType, params };
  }
  return null;
}
