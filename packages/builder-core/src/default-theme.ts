import type { ThemeFiles } from './bundle';
import type { DataSource } from './doc';

// The starter theme a brand-new store adopts (base ⊕ overrides). A real, editable e-commerce home —
// hero, promo posters, two product rows bound to collections (New Arrivals / Trending), and a brand
// story — plus collection + product pages, and an editable header + footer. Every merchant edits THIS.
//
// Header/footer are theme sections (sections/header.liquid, sections/footer.liquid) the merchant can
// edit, but they are NOT listed in any page template: the ORIGIN renders them (renderChrome) into the
// shell of EVERY page — home, collection, product, cart, order — from the store's real name + nav, so
// the whole storefront shares one header/footer. The sanitized menu/footer link tree arrives as the
// `menu` / `footer` context (each item: title, href, external, items, grouped).
//
// Render contract (theme-render.ts): `layout/theme.liquid` wraps the composed sections at
// {{ content_for_layout }}; each `templates/<page>.json` lists section instances; a section `type`
// resolves to `sections/<type>.liquid`. The ORIGIN supplies <!doctype html><head> (with the storefront
// design-system CSS + the store's brand tokens as CSS vars) and <body> — so the layout emits only body
// chrome, and sections use the platform CSS classes (.rt/.hdr/.hero/.grid/.card/.slideshow/.pdp/.ftr,
// see storefront.ts) to look styled out of the box and follow the merchant's brand colour/font.
//
// Data: collection/product templates + the home's two product rows declare `dataSources` and bind a
// section via `dataSourceKey`; the resolver injects the fetched data FLAT into the bound section's
// Liquid context (COLLECTION_BY_HANDLES → { products }, PRODUCT → a flat product). A merchant changes
// which collection a row shows by editing its handle, then Publish → live. Only allowlisted Liquid
// filters (money, escape, default) — a store's Liquid is treated as untrusted.
export function defaultBundleTheme(): ThemeFiles {
  const template = (
    sections: { type: string; data?: Record<string, unknown>; dataSourceKey?: string }[],
    dataSources?: Record<string, DataSource>
  ) => JSON.stringify(dataSources ? { dataSources, sections } : { sections }, null, 2);

  return {
    // The theme's own brand tokens (OFCE-616): per-theme, versioned with the bundle, read by the
    // origin into the storefront <head>. Colour is intentionally omitted so a fresh store keeps the
    // brand colour it chose at onboarding (tenants.theme) until it edits the theme; the rest define
    // this starter's look. Every value is a key into a fixed scale (see storefront.ts ThemeTokens).
    'config/tokens.json': `${JSON.stringify(
      {
        bodyFont: 'system',
        headingFont: 'system',
        baseSize: 'm',
        radius: 'soft',
        container: 'normal',
      },
      null,
      2
    )}\n`,

    // The merchant's own CSS, editable in the code editor. The origin appends it to the storefront
    // <head> AFTER the design-system base + brand tokens, so these rules win. Scope changes to the
    // platform classes (.hdr/.hero/.grid/.card/.ftr, see storefront.ts) or your own section markup.
    'assets/theme.css': `/* Your store's custom CSS — overrides the theme defaults. Example:
   .hdr-brand { letter-spacing: .04em; }
   .hero h1 { font-size: 3rem; }
*/
`,

    // Body chrome only — the origin provides <!doctype html><head>(design-system CSS + brand tokens)</head><body>.
    'layout/theme.liquid': `{{ content_for_layout }}
`,

    // ── Home ────────────────────────────────────────────────────────────────
    'templates/index.json': template(
      [
        {
          type: 'hero',
          data: {
            heading: 'New season, new look',
            subheading: 'Discover the pieces everyone is talking about — curated for you.',
            cta_label: 'Shop new arrivals',
            cta_href: '/collections/all',
          },
        },
        { type: 'promo' },
        {
          type: 'collection-row',
          dataSourceKey: 'all',
          data: { heading: 'New arrivals', cta_href: '/collections/all' },
        },
        {
          type: 'collection-row',
          dataSourceKey: 'new-launches',
          data: { heading: 'New launches', cta_href: '/collections/new-launches' },
        },
        { type: 'brand-story' },
      ],
      {
        // `available: false` asks the commerce backend for the FULL catalog. Its default is
        // available-only, which returns nothing for a store that doesn't flag product availability
        // (so the row renders empty though the collection has products). A theme that wants only
        // in-stock products flips this to true.
        all: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['all'], productLimit: 8, filters: [{ available: false }] },
        },
        'new-launches': {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['new-launches'], productLimit: 8, filters: [{ available: false }] },
        },
      }
    ),

    // ── Collection page ─────────────────────────────────────────────────────
    'templates/collection.json': template([{ type: 'main-collection', dataSourceKey: 'main' }], {
      // `available: false` = the full catalog (the backend default is available-only, which is empty
      // for a store that doesn't flag availability). See the home template's data sources.
      main: {
        type: 'COLLECTION_BY_HANDLES',
        params: {
          handles: ['{{params.handle}}'],
          productLimit: 12,
          filters: [{ available: false }],
        },
      },
    }),

    // ── Product page ────────────────────────────────────────────────────────
    'templates/product.json': template([{ type: 'main-product', dataSourceKey: 'main' }], {
      main: { type: 'PRODUCT', params: { handle: '{{params.handle}}' } },
    }),

    // ── Chrome sections: the editable header + footer. Rendered by the ORIGIN (renderChrome) into the
    // shell of EVERY page — home, collection, product, cart, order — NOT listed in a page template. The
    // sanitized menu/footer link tree arrives as `menu` / `footer`; `site_name` is the store's name.
    // Merchants edit the markup here; hrefs are pre-sanitized, and only the money/escape/default filters
    // are allowed (untrusted). Reproduces the built-in chrome (see nav.ts/footer.ts) — the fallback when
    // a theme has no header/footer section. ──
    'sections/header.liquid': `<header class="hdr"><div class="rt hdr-in">
  <a class="hdr-brand" href="/">{{ site_name | default: 'Store' | escape }}</a>
  {% if menu.size > 0 %}<nav class="hdr-nav">{% for item in menu %}{% if item.items.size > 0 %}<div class="hdr-item"><a class="hdr-link hdr-caret" href="{{ item.href | escape }}"{% if item.external %} target="_blank" rel="noopener noreferrer"{% endif %}>{{ item.title | escape }}</a>{% if item.grouped %}<div class="hdr-drop hdr-drop-acc">{% for group in item.items %}{% if group.items.size > 0 %}<details class="hdr-acc"><summary class="hdr-acc-h">{{ group.title | escape }}</summary><ul class="hdr-acc-list">{% for leaf in group.items %}<li><a class="hdr-drop-link" href="{{ leaf.href | escape }}"{% if leaf.external %} target="_blank" rel="noopener noreferrer"{% endif %}>{{ leaf.title | escape }}</a></li>{% endfor %}</ul></details>{% else %}<a class="hdr-acc-h hdr-acc-solo" href="{{ group.href | escape }}">{{ group.title | escape }}</a>{% endif %}{% endfor %}</div>{% else %}<div class="hdr-drop hdr-drop-list"><ul>{% for leaf in item.items %}<li><a class="hdr-drop-link" href="{{ leaf.href | escape }}"{% if leaf.external %} target="_blank" rel="noopener noreferrer"{% endif %}>{{ leaf.title | escape }}</a></li>{% endfor %}</ul></div>{% endif %}</div>{% else %}<a class="hdr-link" href="{{ item.href | escape }}"{% if item.external %} target="_blank" rel="noopener noreferrer"{% endif %}>{{ item.title | escape }}</a>{% endif %}{% endfor %}</nav>{% endif %}
  <div class="hdr-actions">
    <form class="hdr-search" role="search" action="/search" method="get"><svg class="hdr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg><input name="q" placeholder="Search products" aria-label="Search products"></form>
    <a class="hdr-action hdr-cart" href="/cart" aria-label="Cart"><svg class="hdr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 12.2a1.6 1.6 0 0 0 1.6 1.3h8.2a1.6 1.6 0 0 0 1.6-1.3L22 7H6"/></svg><span class="hdr-badge">0</span><span class="hdr-action-t">Cart</span></a>
    <a class="hdr-action" href="/account" aria-label="Account"><svg class="hdr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span class="hdr-action-t">Account</span></a>
  </div>
</div></header>
`,

    'sections/footer.liquid': `<footer class="ftr"><div class="rt ftr-in">
  {% if footer.size > 0 %}<div class="ftr-cols">{% for col in footer %}<div class="ftr-col"><a class="ftr-col-h" href="{{ col.href | escape }}"{% if col.external %} target="_blank" rel="noopener noreferrer"{% endif %}>{{ col.title | escape }}</a>{% if col.items.size > 0 %}<ul>{% for l in col.items %}<li><a href="{{ l.href | escape }}"{% if l.external %} target="_blank" rel="noopener noreferrer"{% endif %}>{{ l.title | escape }}</a></li>{% endfor %}</ul>{% endif %}</div>{% endfor %}</div>{% endif %}
  <div class="ftr-legal">© {{ site_name | default: 'Store' | escape }} · powered by Ratio</div>
</div></footer>
`,

    // ── Sections (each brings its own container; full-width bars use .hdr/.ftr, content sits in .rt). ──
    'sections/hero.liquid': `<section class="hero">
  <h1>{{ heading | escape }}</h1>
  {% if subheading %}<p>{{ subheading | escape }}</p>{% endif %}
  {% if cta_label %}<a class="btn" href="{{ cta_href | default: '/collections/all' | escape }}">{{ cta_label | escape }}</a>{% endif %}
</section>
`,

    // Promo posters — a horizontal scroller of banner tiles the merchant edits (headings + links).
    'sections/promo.liquid': `<section class="rt">
  <div class="slideshow">
    <a class="slide" href="/collections/new-arrivals"><h2>New arrivals</h2></a>
    <a class="slide" href="/collections/trending"><h2>Trending now</h2></a>
    <a class="slide" href="/collections/sale"><h2>Season sale</h2></a>
  </div>
</section>
`,

    // A product row bound to a collection. The bound collection's products arrive as `products`
    // (flat); `heading` + `cta_href` come from the section's data. Change the collection this shows by
    // editing the template's dataSource handle (e.g. 'new-arrivals' → your own), then Publish.
    'sections/collection-row.liquid': `<section class="rt">
  <h2 class="heading">{{ heading | default: 'Products' | escape }}</h2>
  <div class="grid">
    {% for p in products %}
    {% assign img = p.image_url | default: p.images.first.url %}
    <div class="card">
      <a class="card-link" href="/products/{{ p.handle | escape }}">
        <div class="ph">{% if img %}<img src="{{ img | escape }}" alt="{{ p.title | escape }}">{% endif %}</div>
        <div class="body">
          <div>{{ p.title | escape }}</div>
          <div class="price">{{ p.price | money }}{% if p.compare_at_price and p.compare_at_price > p.price %} <s class="was">{{ p.compare_at_price | money }}</s>{% endif %}</div>
        </div>
      </a>
    </div>
    {% endfor %}
  </div>
  {% if cta_href %}<a class="button" href="{{ cta_href | escape }}">View all</a>{% endif %}
</section>
`,

    'sections/brand-story.liquid': `<section class="rt">
  <div class="rich">
    <h2>About My store</h2>
    <p>We design considered, everyday pieces made to last — thoughtfully sourced and fairly made. Tell your brand's story here so shoppers know who they're buying from.</p>
  </div>
</section>
`,

    // Collection page — the full product grid for the collection in the URL (/collections/:handle).
    'sections/main-collection.liquid': `<main class="rt">
  <h1 class="heading">Collection</h1>
  <div class="grid">
    {% for p in products %}
    {% assign img = p.image_url | default: p.images.first.url %}
    <div class="card">
      <a class="card-link" href="/products/{{ p.handle | escape }}">
        <div class="ph">{% if img %}<img src="{{ img | escape }}" alt="{{ p.title | escape }}">{% endif %}</div>
        <div class="body">
          <div>{{ p.title | escape }}</div>
          <div class="price">{{ p.price | money }}{% if p.compare_at_price and p.compare_at_price > p.price %} <s class="was">{{ p.compare_at_price | money }}</s>{% endif %}</div>
        </div>
      </a>
    </div>
    {% endfor %}
  </div>
</main>
`,

    // Product page — the flat resolved product (title, price in paise, description, image_url, handle).
    // variantId stays EMPTY when the shape carries no real variant (the canonical product has none) so
    // the origin's /cart/add falls back to resolving the variant from `handle`; a product id here would
    // look like a real variant to the server and skip that fallback.
    'sections/main-product.liquid': `<main class="rt pdp">
  {% assign img = image_url | default: images.first.url %}
  <div class="ph">{% if img %}<img src="{{ img | escape }}" alt="{{ title | escape }}">{% endif %}</div>
  <div>
    <h1>{{ title | escape }}</h1>
    <div class="price">{{ price | money }}{% if compare_at_price and compare_at_price > price %} <s class="was">{{ compare_at_price | money }}</s>{% endif %}</div>
    {% if description %}<div class="rte"><p>{{ description | escape }}</p></div>{% endif %}
    <form class="atc" method="post" action="/cart/add">
      <input type="hidden" name="variantId" value="{{ variant_id | default: variants.first.id | escape }}">
      <input type="hidden" name="handle" value="{{ handle | escape }}">
      <button type="submit" class="btn atc-btn">Add to cart</button>
    </form>
  </div>
</main>
`,
  };
}
