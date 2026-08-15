import type { ThemeFiles } from './bundle';
import type { DataSource } from './doc';

// A minimal but VALID starter theme for a brand-new store, following the origin render contract
// (theme-render.ts): `layout/theme.liquid` is the shell (holds {{ content_for_layout }}); pages are
// `templates/<name>.json` section manifests (home→index, collection, product); each section `type`
// resolves to `sections/<type>.liquid`. Seeded when a store first opens the code editor so the tree
// starts with a working home/collection/product page instead of empty. Kept deliberately plain — it
// is a starting point the merchant edits, not the design system.
//
// The collection/product templates (and the home's featured grid) declare `dataSources` and bind
// their section via `dataSourceKey`, so a fresh store renders REAL products out of the box: the
// resolver injects the fetched data (COLLECTION_BY_HANDLES → { products }, PRODUCT → a flat product)
// straight into the bound section's Liquid context (theme-render.ts). Templates use only allowlisted
// Liquid filters (money, escape, default) since a store's Liquid is treated as untrusted.
export function defaultBundleTheme(): ThemeFiles {
  const template = (
    sections: { type: string; data?: Record<string, unknown>; dataSourceKey?: string }[],
    dataSources?: Record<string, DataSource>
  ) => JSON.stringify(dataSources ? { dataSources, sections } : { sections }, null, 2);
  return {
    'layout/theme.liquid': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My store</title>
  </head>
  <body>
    {{ content_for_layout }}
  </body>
</html>
`,
    'templates/index.json': template(
      [
        { type: 'header' },
        {
          type: 'hero',
          data: {
            heading: 'Welcome to your store',
            subheading: 'Edit this theme in the code editor.',
          },
        },
        { type: 'featured-products', dataSourceKey: 'main' },
        { type: 'footer' },
      ],
      {
        main: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['featured'], productLimit: 8 },
        },
      }
    ),
    'templates/collection.json': template(
      [{ type: 'header' }, { type: 'main-collection', dataSourceKey: 'main' }, { type: 'footer' }],
      {
        main: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['{{params.handle}}'], productLimit: 12 },
        },
      }
    ),
    'templates/product.json': template(
      [{ type: 'header' }, { type: 'main-product', dataSourceKey: 'main' }, { type: 'footer' }],
      { main: { type: 'PRODUCT', params: { handle: '{{params.handle}}' } } }
    ),
    'sections/header.liquid': `<header class="site-header">
  <a class="site-logo" href="/">My store</a>
</header>
`,
    'sections/footer.liquid': `<footer class="site-footer">
  <p>&copy; My store</p>
</footer>
`,
    'sections/hero.liquid': `<section class="hero">
  <h1>{{ heading | escape }}</h1>
  <p>{{ subheading | escape }}</p>
</section>
`,
    // The collection's products are merged into this section's context as `products` (each a canonical
    // product: title, handle, price in paise, image_url). Price → rupees via the `money` filter.
    'sections/main-collection.liquid': `<main class="collection">
  <h1>Collection</h1>
  <div class="product-grid">
    {% for p in products %}
    <a class="product-card" href="/products/{{ p.handle | escape }}">
      {% if p.image_url %}<img src="{{ p.image_url | escape }}" alt="{{ p.title | escape }}">{% endif %}
      <div class="product-title">{{ p.title | escape }}</div>
      <div class="product-price">{{ p.price | money }}</div>
    </a>
    {% endfor %}
  </div>
</main>
`,
    // Same product list, shown on the home page as a featured grid. `featured` is a placeholder
    // collection handle the merchant points at their own collection.
    'sections/featured-products.liquid': `<section class="featured-products">
  <h2>Featured products</h2>
  <div class="product-grid">
    {% for p in products %}
    <a class="product-card" href="/products/{{ p.handle | escape }}">
      {% if p.image_url %}<img src="{{ p.image_url | escape }}" alt="{{ p.title | escape }}">{% endif %}
      <div class="product-title">{{ p.title | escape }}</div>
      <div class="product-price">{{ p.price | money }}</div>
    </a>
    {% endfor %}
  </div>
</section>
`,
    // The resolved PRODUCT is a flat object merged into this section's context: title, price (paise),
    // description, image_url, handle.
    'sections/main-product.liquid': `<main class="product">
  {% if image_url %}<img class="product-image" src="{{ image_url | escape }}" alt="{{ title | escape }}">{% endif %}
  <h1>{{ title | escape }}</h1>
  <div class="product-price">{{ price | money }}</div>
  <div class="product-description">{{ description | escape }}</div>
</main>
`,
  };
}
