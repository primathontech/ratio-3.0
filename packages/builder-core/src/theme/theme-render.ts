// Render a page from a compiled theme bundle (LLD BC5): read the page template (which sections + each
// section's data) and each section's Liquid from the bundle, render every section with its OWN data
// context, and concatenate — the same per-section-data model as composePage.
//
// The section renderer is INJECTED. In-process rendering of UNTRUSTED merchant Liquid is unsafe
// (D4 — no hard wall-clock kill, engine-bug exposure), so the origin passes an isolate-backed
// renderer (@ratio/builder-render/isolate) for merchant sections; a first-party/trusted path may pass
// an in-process one. This module is pure composition and never renders in-process itself.
import type { ThemeFiles } from './bundle';
import type { DataSource } from '../page-builder/doc';
import type { BindingResolver, ResolveContext } from '../commerce/resolve';
import { interpolateParams } from '../commerce/resolve';

// Renders one THEME section's Liquid with its data context to HTML. Theme sections (base or merchant)
// carry their Liquid in the bundle; for untrusted merchant sections this MUST run inside the
// worker-thread isolate — the caller owns that decision.
export type SectionRenderer = (liquid: string, data: Record<string, unknown>) => Promise<string>;

// Renders a PLATFORM (first-party, trusted) section by its type. A platform section's markup lives in
// central code (the section registry), not the bundle — so it's referenced by type, never forked or
// sandboxed. The caller wires the registry.
export type PlatformRenderer = (type: string, data: Record<string, unknown>) => Promise<string>;

// The two render strategies a page dispatches between (LLD R2 / the "two section flavors"): theme
// sections render their bundled Liquid, platform sections render from code.
export interface SectionRenderers {
  theme: SectionRenderer;
  platform?: PlatformRenderer;
}

interface SectionInstance {
  type: string;
  data?: Record<string, unknown>; // the section's render context (settings values + bound data)
  dataSourceKey?: string; // binds this section to a page-level dataSource, resolved at render
}
interface PageTemplate {
  sections: SectionInstance[];
  dataSources?: Record<string, DataSource>; // named live-data sources sections bind to
}

const templatePath = (page: string) => `templates/${page}.json`;
const sectionPath = (type: string) => `sections/${type}.liquid`;
const LAYOUT_PATH = 'layout/theme.liquid';
const ASSET_BASE_CSS = 'assets/base.css';
const ASSET_THEME_CSS = 'assets/theme.css';

// The render context the theme's `layout/theme.liquid` receives, ON TOP OF `content_for_layout` (the
// composed sections) and the auto-injected `base_css`/`theme_css` (read from the bundle's own assets).
// Everything here is ORIGIN-supplied — under full theme ownership (OFCE-630) the theme owns the whole
// document and the origin only fills these slots:
//   - content_for_header: the ONLY platform-owned part of the document (OFCE-634) — the islands
//     hydration runtime (when the page has one), external-integration head fragments, and security
//     bits. Trusted, origin-built HTML — never merchant markup.
//   - header/footer: the rendered chrome, from the theme's own sections/header.liquid + footer.liquid.
//   - token_css: the brand-token :root{} overrides the origin computes from the tenant theme
//     (sanitized), placed by the layout between base_css and theme_css so the cascade resolves.
//   - page_title/site_name/settings: page + theme metadata the layout's <head> reads. These are plain
//     text, NOT pre-escaped — LiquidJS does not auto-escape {{ }}, so the layout MUST use `| escape` on
//     them (they can carry merchant-supplied values), unlike the trusted HTML slots above.
export interface LayoutContext {
  content_for_header?: string;
  header?: string;
  footer?: string;
  token_css?: string;
  page_title?: string;
  site_name?: string;
  settings?: Record<string, unknown>;
}

// Render one page of a compiled bundle to HTML, section by section, each with its own data context.
// Each section dispatches on whether the bundle carries Liquid for its type: present → a THEME section
// (render its Liquid); absent → a PLATFORM section (render by type from code). A platform section with
// no platform renderer wired is an error, same as a missing theme section.
export async function renderThemePage(
  compiled: ThemeFiles,
  page: string,
  renderers: SectionRenderers,
  opts: { resolver?: BindingResolver; ctx?: ResolveContext; layout?: LayoutContext } = {}
): Promise<{ html: string; tags: string[] }> {
  const raw = compiled[templatePath(page)];
  if (raw == null) throw new Error(`no template for page '${page}'`);
  const tpl = JSON.parse(raw) as PageTemplate;

  // Resolve page-level data sources once via the injected resolver (the same BindingResolver the
  // legacy path uses), then merge each resolved value's keys into the sections that bind to it — so
  // a theme section's Liquid can reference live data (e.g. {% for product in products %}) by name.
  // The resolver's cache tags are returned so the origin can purge the page when that data changes.
  const resolved: Record<string, Record<string, unknown>> = {};
  const tags: string[] = [];
  if (opts.resolver && tpl.dataSources) {
    const ctx = opts.ctx ?? { tenantId: '' };
    const routeParams = ctx.routeParams ?? {};
    const entries = Object.entries(tpl.dataSources);
    const values = await Promise.all(
      entries.map(([, src]) =>
        opts.resolver!.fetch(
          { ...src, params: interpolateParams(src.params ?? {}, routeParams) },
          ctx
        )
      )
    );
    entries.forEach(([key], i) => {
      resolved[key] = values[i].value;
      tags.push(...values[i].tags);
    });
  }

  const parts: string[] = [];
  for (const inst of tpl.sections) {
    const bound = inst.dataSourceKey ? (resolved[inst.dataSourceKey] ?? {}) : {};
    const liquid = compiled[sectionPath(inst.type)];
    // Bound live data fills the context; an authored setting of the same name WINS, so resolved data
    // can never silently overwrite what the merchant set. (Per-binding namespacing — Shopify-style
    // collection.* / product.* kept apart from settings — is a later slice; this is the safe interim.)
    const data = { ...bound, ...(inst.data ?? {}) };
    if (liquid != null) {
      parts.push(await renderers.theme(liquid, data));
    } else if (renderers.platform) {
      parts.push(await renderers.platform(inst.type, data));
    } else {
      throw new Error(`no section '${inst.type}' in the theme`);
    }
  }
  // The theme's own layout (Shopify's layout/theme.liquid) owns the WHOLE document — <head> (title,
  // CSS, the platform content_for_header slice) and <body> (header/footer chrome + where the composed
  // sections go, {{ content_for_layout }}) — rendered like any theme section (isolate at the origin).
  // The design-system CSS (assets/base.css) and merchant CSS (assets/theme.css) are read straight from
  // the bundle; the origin fills the rest of LayoutContext. content_for_layout is set LAST so a caller
  // can never override it. Absent layout → the sections are the whole body and the origin supplies the
  // document (legacy TS shell, until every store is rebased onto a full-document layout).
  const content = parts.join('\n');
  const layout = compiled[LAYOUT_PATH];
  if (layout == null) return { html: content, tags: [...new Set(tags)] };
  // Every CSS string inlined into the layout's <style> — base, brand tokens, merchant — is neutralized
  // against a </style> breakout. Valid CSS never contains </style>, so this only blocks the one way CSS
  // could close its element early and inject markup. Defense-in-depth; the storefront CSP (script-src
  // 'none') is the primary control. Same guard the legacy storefrontHead() applied. token_css is guarded
  // too even though the origin sanitizes it upstream — the boundary stays uniform for all three.
  const provided = opts.layout ?? {};
  const neutralizeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style');
  const asCss = (v: unknown) => neutralizeStyle(typeof v === 'string' ? v : '');
  const layoutData: Record<string, unknown> = {
    content_for_header: '',
    header: '',
    footer: '',
    ...provided,
    // Set AFTER the spread so a caller can never override the bundle-derived CSS or content_for_layout.
    base_css: asCss(compiled[ASSET_BASE_CSS]),
    theme_css: asCss(compiled[ASSET_THEME_CSS]),
    token_css: asCss(provided.token_css),
    content_for_layout: content,
  };
  const html = await renderers.theme(layout, layoutData);
  return { html, tags: [...new Set(tags)] };
}
