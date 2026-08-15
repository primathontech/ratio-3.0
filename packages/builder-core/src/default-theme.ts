import type { ThemeFiles } from './bundle';
import type { DataSource } from './doc';

// The starter theme a brand-new store adopts (base ⊕ overrides). A real, editable e-commerce home —
// header + nav, hero, promo posters, two product rows bound to collections (New Arrivals / Trending),
// a brand story, and a rich footer — plus collection + product pages. Every merchant edits THIS.
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
    // Body chrome only — the origin provides <!doctype html><head>(design-system CSS + brand tokens)</head><body>.
    'layout/theme.liquid': `{{ content_for_layout }}
`,

    // ── Home ────────────────────────────────────────────────────────────────
    'templates/index.json': template(
      [
        { type: 'header' },
        {
          type: 'hero',
          data: {
            heading: 'New season, new look',
            subheading: 'Discover the pieces everyone is talking about — curated for you.',
            cta_label: 'Shop new arrivals',
            cta_href: '/collections/new-arrivals',
          },
        },
        { type: 'promo' },
        {
          type: 'collection-row',
          dataSourceKey: 'new_arrivals',
          data: { heading: 'New arrivals', cta_href: '/collections/new-arrivals' },
        },
        {
          type: 'collection-row',
          dataSourceKey: 'trending',
          data: { heading: 'Trending now', cta_href: '/collections/trending' },
        },
        { type: 'brand-story' },
        { type: 'footer' },
      ],
      {
        new_arrivals: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['new-arrivals'], productLimit: 8 },
        },
        trending: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['trending'], productLimit: 8 },
        },
      }
    ),

    // ── Collection page ─────────────────────────────────────────────────────
    'templates/collection.json': template(
      [{ type: 'header' }, { type: 'main-collection', dataSourceKey: 'main' }, { type: 'footer' }],
      {
        main: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['{{params.handle}}'], productLimit: 12 },
        },
      }
    ),

    // ── Product page ────────────────────────────────────────────────────────
    'templates/product.json': template(
      [{ type: 'header' }, { type: 'main-product', dataSourceKey: 'main' }, { type: 'footer' }],
      { main: { type: 'PRODUCT', params: { handle: '{{params.handle}}' } } }
    ),

    // ── Sections (each brings its own container; full-width bars use .hdr/.ftr, content sits in .rt) ──
    'sections/header.liquid': `<header class="hdr">
  <div class="rt hdr-in">
    <a class="hdr-brand" href="/">My store</a>
    <nav class="hdr-nav">
      <span class="hdr-item"><a class="hdr-link" href="/collections/new-arrivals">New arrivals</a></span>
      <span class="hdr-item"><a class="hdr-link" href="/collections/trending">Trending</a></span>
      <span class="hdr-item"><a class="hdr-link" href="/collections/all">Shop all</a></span>
    </nav>
    <div class="hdr-actions">
      <a class="hdr-action" href="/cart">Cart</a>
    </div>
  </div>
</header>
`,

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

    'sections/footer.liquid': `<footer class="ftr">
  <div class="rt ftr-in">
    <div class="ftr-cols">
      <div class="ftr-col">
        <span class="ftr-col-h">Shop</span>
        <ul>
          <li><a href="/collections/new-arrivals">New arrivals</a></li>
          <li><a href="/collections/trending">Trending</a></li>
          <li><a href="/collections/all">Shop all</a></li>
        </ul>
      </div>
      <div class="ftr-col">
        <span class="ftr-col-h">About</span>
        <ul>
          <li><a href="/pages/about">Our story</a></li>
          <li><a href="/pages/contact">Contact</a></li>
        </ul>
      </div>
      <div class="ftr-col">
        <span class="ftr-col-h">Help</span>
        <ul>
          <li><a href="/pages/shipping">Shipping &amp; returns</a></li>
          <li><a href="/pages/faq">FAQ</a></li>
        </ul>
      </div>
    </div>
    <div class="ftr-legal">&copy; My store. All rights reserved.</div>
  </div>
</footer>
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
    'sections/main-product.liquid': `<main class="rt pdp">
  {% assign img = image_url | default: images.first.url %}
  <div class="ph">{% if img %}<img src="{{ img | escape }}" alt="{{ title | escape }}">{% endif %}</div>
  <div>
    <h1>{{ title | escape }}</h1>
    <div class="price">{{ price | money }}{% if compare_at_price and compare_at_price > price %} <s class="was">{{ compare_at_price | money }}</s>{% endif %}</div>
    {% if description %}<div class="rte"><p>{{ description | escape }}</p></div>{% endif %}
    <form class="atc" method="post" action="/cart/add">
      <input type="hidden" name="variantId" value="{{ variant_id | default: id | default: handle | escape }}">
      <input type="hidden" name="handle" value="{{ handle | escape }}">
      <button type="submit" class="btn atc-btn">Add to cart</button>
    </form>
  </div>
</main>
`,
  };
}
