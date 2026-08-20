// Render a page from a compiled theme bundle (LLD BC5): read the page template (which sections + each
// section's data) and each section's Liquid from the bundle, render every section with its OWN data
// context, and concatenate — the same per-section-data model as composePage.
//
// The section renderer is INJECTED. In-process rendering of UNTRUSTED merchant Liquid is unsafe
// (D4 — no hard wall-clock kill, engine-bug exposure), so the origin passes an isolate-backed
// renderer (@ratio/builder-render/isolate) for merchant sections; a first-party/trusted path may pass
// an in-process one. This module is pure composition and never renders in-process itself.
import type { ThemeFiles } from './bundle';
import { readAssetManifest } from './assets';
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

// The map the `asset_url` Liquid filter reads: each asset PATH the theme references → the URL the origin
// serves it at (`/assets/<hash>` — content-addressed, so immutable + CDN-cacheable). Derived from the
// theme's own manifest (config/assets.json) and injected into every section + the layout render context,
// so `{{ 'logo.png' | asset_url }}` resolves to the served URL. Empty when the theme has no assets.
export function assetUrlMap(compiled: ThemeFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of Object.entries(readAssetManifest(compiled))) {
    out[path] = `/assets/${entry.hash}`;
  }
  return out;
}

// The render context the theme's `layout/theme.liquid` receives, ON TOP OF `content_for_layout` (the
// composed sections) and the auto-injected `base_css`/`theme_css` (read from the bundle's own assets).
// Everything here is ORIGIN-supplied — under full theme ownership (OFCE-630) the theme owns the whole
// document and the origin only fills these slots:
//   - content_for_header: the platform-owned part of the document <head> (OFCE-634) — the islands
//     hydration runtime (when the page has one), external-integration head fragments, and security
//     bits. Trusted, origin-built HTML — never merchant markup.
//   - content_for_body_end: the platform-owned part just before </body> — external-integration body
//     scripts (e.g. the GoKwik side-cart bootstrap). Trusted, origin-built, same contract as the header.
//   - header/footer: the rendered chrome, from the theme's own sections/header.liquid + footer.liquid.
//   - token_css: the brand-token :root{} overrides the origin computes from the tenant theme
//     (sanitized), placed by the layout between base_css and theme_css so the cascade resolves.
//   - page_title/site_name/settings: page + theme metadata the layout's <head> reads. These are plain
//     text, NOT pre-escaped — LiquidJS does not auto-escape {{ }}, so the layout MUST use `| escape` on
//     them (they can carry merchant-supplied values), unlike the trusted HTML slots above.
export interface LayoutContext {
  content_for_header?: string;
  content_for_body_end?: string;
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
  opts: {
    resolver?: BindingResolver;
    ctx?: ResolveContext;
    layout?: LayoutContext;
    applyLayout?: boolean;
  } = {}
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

  // The map the `asset_url` filter reads (path → /assets/<hash>), from the theme's own manifest —
  // injected into every section + the layout so `{{ 'logo.png' | asset_url }}` resolves. Built once.
  const asset_urls = assetUrlMap(compiled);

  const parts: string[] = [];
  for (const inst of tpl.sections) {
    const bound = inst.dataSourceKey ? (resolved[inst.dataSourceKey] ?? {}) : {};
    const liquid = compiled[sectionPath(inst.type)];
    // Bound live data fills the context; an authored setting of the same name WINS, so resolved data
    // can never silently overwrite what the merchant set. (Per-binding namespacing — Shopify-style
    // collection.* / product.* kept apart from settings — is a later slice; this is the safe interim.)
    // asset_urls is pinned LAST — a reserved key a section can't shadow.
    const data = { ...bound, ...(inst.data ?? {}), asset_urls };
    if (liquid != null) {
      parts.push(await renderers.theme(liquid, data));
    } else if (renderers.platform) {
      parts.push(await renderers.platform(inst.type, data));
    } else {
      throw new Error(`no section '${inst.type}' in the theme`);
    }
  }
  // The theme's own layout/theme.liquid owns the WHOLE document (see renderThemeLayout). applyLayout:false
  // forces sections-only output (skip the layout) even when the theme has one — the origin uses it in
  // legacy (flag-off) mode so a full-document layout is never applied and then double-wrapped by the TS
  // shell. Absent layout → the sections are the whole body (the origin supplies the document).
  const content = parts.join('\n');
  if (compiled[LAYOUT_PATH] == null || opts.applyLayout === false)
    return { html: content, tags: [...new Set(tags)] };
  const html = await renderThemeLayout(compiled, renderers.theme, {
    ...(opts.layout ?? {}),
    content_for_layout: content,
  });
  return { html, tags: [...new Set(tags)] };
}

// Render a theme's layout/theme.liquid into the whole HTML document (full theme ownership, OFCE-630):
// <head> (title, the CSS layers, the platform {{ content_for_header }} slice) and <body> (header/footer
// chrome, {{ content_for_layout }} = the composed sections, the platform {{ content_for_body_end }}
// slice). The design-system CSS (assets/base.css) and merchant CSS (assets/theme.css) are read from the
// bundle and inlined around the origin's token_css in cascade order; every CSS string is neutralized
// against a </style> breakout (defense-in-depth; the storefront CSP script-src 'none' is the primary
// control). content_for_layout is pinned LAST so a caller can never override the composed body. Exported
// so the origin can apply the layout as a final step AFTER rendering sections + chrome in parallel. No
// layout in the bundle → the composed sections are returned as the whole body.
// Does this layout/theme.liquid own the WHOLE document (full theme ownership) rather than just wrap the
// body? A full-document layout MUST begin with <!doctype (or <html). The check is anchored to the START
// of the source — a stray <!doctype/<html inside a Liquid comment or a pasted example elsewhere in the
// file must NOT flip the mode. Under full theme ownership (OFCE-641) there is no TS-shell fallback: the
// publish/activate/rollback invariant refuses to make a non-full-document theme live, and the origin
// fails LOUD (500) if one ever reaches render rather than serving a headless document.
export function layoutOwnsDocument(layoutSource: string | undefined | null): boolean {
  const s = (layoutSource ?? '').trimStart().toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html');
}

export async function renderThemeLayout(
  compiled: ThemeFiles,
  render: SectionRenderer,
  ctx: LayoutContext & { content_for_layout: string }
): Promise<string> {
  const layout = compiled[LAYOUT_PATH];
  if (layout == null) return ctx.content_for_layout;
  const asCss = (v: unknown) => (typeof v === 'string' ? v : '').replace(/<\/style/gi, '<\\/style');
  const { content_for_layout, token_css, ...provided } = ctx;
  const layoutData: Record<string, unknown> = {
    content_for_header: '',
    content_for_body_end: '',
    header: '',
    footer: '',
    ...provided,
    // Set AFTER the spread so a caller can never override the bundle-derived CSS or content_for_layout.
    base_css: asCss(compiled[ASSET_BASE_CSS]),
    // The CDN URL of the promoted base stylesheet (OFCE-701), or '' when it isn't in the manifest
    // (preview/local/tests) — the layout links it when present, else inlines base_css as a fallback.
    base_css_url: assetUrlMap(compiled)[ASSET_BASE_CSS] ?? '',
    theme_css: asCss(compiled[ASSET_THEME_CSS]),
    token_css: asCss(token_css),
    asset_urls: assetUrlMap(compiled),
    content_for_layout,
  };
  return render(layout, layoutData);
}
