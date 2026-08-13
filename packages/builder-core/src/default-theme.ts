import type { ThemeFiles } from './bundle';

// A minimal but VALID starter theme for a brand-new store, following the origin render contract
// (theme-render.ts): `layout/theme.liquid` is the shell (holds {{ content_for_layout }}); pages are
// `templates/<name>.json` section manifests (home→index, collection, product); each section `type`
// resolves to `sections/<type>.liquid`. Seeded when a store first opens the code editor so the tree
// starts with a working home/collection/product page instead of empty. Kept deliberately plain — it
// is a starting point the merchant edits, not the design system.
export function defaultBundleTheme(): ThemeFiles {
  const template = (sections: { type: string; data?: Record<string, unknown> }[]) =>
    JSON.stringify({ sections }, null, 2);
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
    'templates/index.json': template([
      { type: 'header' },
      {
        type: 'hero',
        data: {
          heading: 'Welcome to your store',
          subheading: 'Edit this theme in the code editor.',
        },
      },
      { type: 'footer' },
    ]),
    'templates/collection.json': template([
      { type: 'header' },
      { type: 'main-collection' },
      { type: 'footer' },
    ]),
    'templates/product.json': template([
      { type: 'header' },
      { type: 'main-product' },
      { type: 'footer' },
    ]),
    'sections/header.liquid': `<header class="site-header">
  <a class="site-logo" href="/">My store</a>
</header>
`,
    'sections/footer.liquid': `<footer class="site-footer">
  <p>&copy; My store</p>
</footer>
`,
    'sections/hero.liquid': `<section class="hero">
  <h1>{{ heading }}</h1>
  <p>{{ subheading }}</p>
</section>
`,
    'sections/main-collection.liquid': `<main class="collection">
  <h1>Collection</h1>
  <p>Products in this collection appear here.</p>
</main>
`,
    'sections/main-product.liquid': `<main class="product">
  <h1>Product</h1>
  <p>Product details appear here.</p>
</main>
`,
  };
}
