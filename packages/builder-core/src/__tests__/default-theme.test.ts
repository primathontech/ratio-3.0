// The default starter theme must be VALID against the origin render contract (theme-render.ts): the
// layout holds the content slot, and every templates/*.json is parseable and references sections that
// actually exist as sections/<type>.liquid — otherwise a freshly-seeded store fails to render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { defaultBundleTheme } from '../theme/default-theme';
import { storefrontHead } from '../storefront/storefront';
import { renderThemePage } from '../theme/theme-render';
import { StubResolver } from '../commerce/resolve';
import type { SectionRenderer } from '../theme/theme-render';

const theme: SectionRenderer = (liquid, data) => render(liquid, data, { trusted: true });
const renderPage = (page: string, routeParams: Record<string, string> = {}) =>
  renderThemePage(
    defaultBundleTheme(),
    page,
    { theme },
    {
      resolver: new StubResolver(),
      ctx: { tenantId: 't1', routeParams },
    }
  );

// OFCE-630: the theme owns the WHOLE document, not just the body sections. The layout is a full
// <!doctype html> page — it owns <head> (title, the design-system + brand CSS, the platform
// content_for_header slice) and <body> (header/footer chrome slots + content_for_layout + the platform
// content_for_body_end slice).
test('default theme layout owns the whole document (doctype, head, platform slices, chrome slots)', () => {
  const layout = defaultBundleTheme()['layout/theme.liquid'];
  assert.match(layout, /<!doctype html>/i, 'the layout is a full HTML document');
  assert.match(layout, /<html/i);
  assert.match(layout, /<head>/i);
  assert.match(layout, /<title>/i, 'the theme owns its <title> (SEO)');
  assert.match(
    layout,
    /\{\{\s*content_for_header\s*\}\}/,
    'the head platform slice placeholder is present'
  );
  assert.match(
    layout,
    /\{\{\s*content_for_body_end\s*\}\}/,
    'the body-end platform slice placeholder is present'
  );
  assert.match(layout, /\{\{\s*content_for_layout\s*\}\}/, 'the sections slot is present');
  assert.match(layout, /\{\{\s*header\s*\}\}/, 'the header chrome slot is present');
  assert.match(layout, /\{\{\s*footer\s*\}\}/, 'the footer chrome slot is present');
  assert.match(layout, /\{\{\s*base_css\s*\}\}/, 'the theme inlines its design-system CSS');
  // page_title/site_name are merchant/store text → must be escaped in the layout.
  assert.match(layout, /page_title[\s\S]*\|\s*escape/, 'the title is escaped');
});

test('default theme ships the design-system CSS as an editable asset (assets/base.css)', () => {
  const files = defaultBundleTheme();
  assert.ok('assets/base.css' in files, 'the theme ships assets/base.css');
  assert.match(
    files['assets/base.css'],
    /\.hdr\b/,
    'carries the component classes sections depend on'
  );
  assert.match(files['assets/base.css'], /:root\{/, 'carries the base brand-token defaults');
});

test('default theme: layout holds content_for_layout and templates reference existing sections', () => {
  const files = defaultBundleTheme();

  assert.match(files['layout/theme.liquid'], /\{\{\s*content_for_layout\s*\}\}/);

  const templates = Object.keys(files).filter(
    (p) => p.startsWith('templates/') && p.endsWith('.json')
  );
  assert.ok(templates.includes('templates/index.json'), 'has a home template');

  for (const t of templates) {
    const doc = JSON.parse(files[t]) as { sections: { type: string }[] };
    assert.ok(Array.isArray(doc.sections) && doc.sections.length > 0, `${t} lists sections`);
    for (const s of doc.sections) {
      assert.ok(
        files[`sections/${s.type}.liquid`] !== undefined,
        `${t} references sections/${s.type}.liquid which must exist`
      );
    }
  }
});

test('starter theme collection sources request the full catalog (available:false), not available-only', () => {
  // The commerce backend filters to available-only by default, which is EMPTY for a store that
  // doesn't flag product availability — the row then renders blank though the collection has
  // products. The requirement lives in the theme config (what to fetch), not in the resolver.
  const files = defaultBundleTheme();
  for (const t of ['templates/index.json', 'templates/collection.json']) {
    const doc = JSON.parse(files[t]) as {
      dataSources?: Record<string, { type: string; params?: { filters?: unknown } }>;
    };
    for (const [key, ds] of Object.entries(doc.dataSources ?? {})) {
      if (ds.type === 'COLLECTION_BY_HANDLES') {
        assert.deepStrictEqual(
          ds.params?.filters,
          [{ available: false }],
          `${t} data source ${key} must request the full catalog`
        );
      }
    }
  }
});

test('starter theme ships an editable CSS file, injected into the head AFTER the base styles', () => {
  const files = defaultBundleTheme();
  assert.ok('assets/theme.css' in files, 'the theme ships an editable assets/theme.css');
  const head = storefrontHead({}, '/*CUSTOM_MARKER*/');
  assert.match(head, /CUSTOM_MARKER/, 'the custom CSS reaches the head');
  assert.ok(
    head.indexOf('/*CUSTOM_MARKER*/') > head.indexOf('.hdr'),
    'custom CSS comes after the base rules so it overrides them'
  );
  assert.ok(
    head.indexOf('/*CUSTOM_MARKER*/') < head.indexOf('</style>'),
    'custom CSS is inside the style block'
  );
  // Custom CSS must not be able to close its own <style> element and inject markup.
  const evil = storefrontHead({}, '.x{}</style><script>alert(1)</script>');
  assert.doesNotMatch(
    evil,
    /<\/style><script/i,
    'a </style> breakout in custom CSS is neutralized'
  );
});

test("a store's brand token override wins over the base defaults (cascade order)", () => {
  // BASE ships a full :root of default tokens; the per-theme overrides re-declare the same vars, so
  // they MUST be emitted AFTER the base or the default silently wins and the brand colour never applies.
  const head = storefrontHead({ color: '#ff0000' });
  assert.match(head, /--accent:#ff0000/, 'the brand colour override is present');
  assert.ok(
    head.lastIndexOf('--accent:#ff0000') > head.indexOf('--accent:#2563eb'),
    'the override comes after the base default --accent, so it wins the cascade'
  );
});

test('starter theme ships an editable order (thank-you) section with the hydration hook intact', async () => {
  const files = defaultBundleTheme();
  const liquid = files['sections/order.liquid'];
  assert.ok(liquid, 'the theme ships an editable sections/order.liquid');
  // The origin renders it with the order context (total in paise → money filter).
  const html = await render(
    liquid,
    { order_id: 'ORD-9', total: 49900, payment_method: 'UPI' },
    { trusted: true }
  );
  assert.match(html, /Thank you/, 'the thank-you heading renders');
  assert.match(html, /ORD-9/, 'the order id renders');
  assert.match(html, /₹499\.00/, 'the total is formatted from paise via the money filter');
  assert.match(html, /UPI/, 'the payment method renders');
  // The checkout integration fills this element client-side — editing must keep the id.
  assert.match(html, /id="rt-order-items"/, 'the line-item hydration hook survives');
});

test('default theme binds + renders the collection products with rupee prices', async () => {
  const { html } = await renderPage('collection', { handle: 'summer' });
  assert.match(html, /Sample product 1/, 'a resolved product title renders');
  assert.match(html, /₹499\.00/, 'the paise price is formatted to rupees via money');
  assert.match(html, /href="\/products\/sample-1"/, 'each card links to its product page');
});

test('default theme renders the product detail page', async () => {
  const { html } = await renderPage('product', { handle: 'air-max-90' });
  assert.match(html, /Sample: air-max-90/, 'the resolved product title renders');
  assert.match(html, /₹999\.00/, 'the product price is formatted to rupees');
});

test('default theme PDP leaves variantId empty so the origin resolves it from the handle', async () => {
  // The canonical product shape carries no real variant id. If the add-to-cart form sent the product
  // id/handle as variantId it would look authoritative to /cart/add and skip resolveVariant(handle).
  const { html } = await renderPage('product', { handle: 'air-max-90' });
  assert.match(html, /name="variantId"\s+value=""/, 'variantId is empty on the sample product');
  assert.match(
    html,
    /name="handle"\s+value="air-max-90"/,
    'the handle is sent for server-side resolution'
  );
});

test('default theme home fills product rows for a connected store that lacks the all/new-launches collections', async () => {
  // A real merchant whose catalog has NO collection matching a fixed handle: the backend returns
  // products for a PRODUCTS listing but nothing for COLLECTION_BY_HANDLES. The home must still show
  // products out of the box — so its product rows bind a handle-independent listing, not specific
  // collection handles a fresh store may not have. (StubResolver hides this: it fakes products for
  // COLLECTION too, so the older stub-only test passes even when the real home would be empty.)
  const listingParams: Record<string, unknown>[] = [];
  const catalogOnly = {
    async fetch(source: { type: string; params?: Record<string, unknown> }) {
      if (source.type === 'PRODUCTS' || source.type === 'PRODUCTS_BY_HANDLES') {
        listingParams.push(source.params ?? {});
        return {
          value: {
            products: [{ id: 'p1', title: 'Real Catalog Tee', handle: 'real-tee', price: 12345 }],
          },
          tags: [],
        };
      }
      return { value: { products: [] }, tags: [] }; // no collection matches this merchant's handles
    },
  };
  const { html } = await renderThemePage(
    defaultBundleTheme(),
    'index',
    { theme },
    {
      resolver: catalogOnly as never,
      ctx: { tenantId: 't1', routeParams: {} },
    }
  );
  assert.match(
    html,
    /Real Catalog Tee/,
    'the home shows real products without an all/new-launches collection'
  );
  assert.match(html, /₹123\.45/, 'listing prices render in rupees');
  // The rows must cap results via `first` — the field getProducts honours. `productLimit` is a
  // COLLECTION-only field getProducts ignores (it would default to 20), so a bad param name would
  // silently over-fetch. Guard the exact field the backend reads.
  assert.ok(listingParams.length >= 1, 'the home issued at least one PRODUCTS listing');
  for (const p of listingParams) {
    assert.equal(
      p.first,
      8,
      'the listing caps page-size via `first` (not the ignored productLimit)'
    );
    assert.equal(p.productLimit, undefined, 'no productLimit — getProducts would ignore it');
  }
});

test('default theme home shows product rows (New arrivals + Trending) out of the box', async () => {
  const { html } = await renderPage('index');
  assert.match(html, /New arrivals/, 'the New arrivals row heading renders');
  assert.match(html, /Trending now/, 'the Trending row heading renders');
  assert.match(html, /Sample product 1/, 'products render on the home page');
  assert.match(html, /₹499\.00/, 'home prices are formatted to rupees');
  // Uses the platform design-system classes so it's styled by the origin's storefront stylesheet.
  assert.match(html, /class="grid"/, 'product rows use the .grid card layout');
  // The header/footer are NOT theme sections — the origin renders them in the page shell (OFCE-618),
  // so the theme body itself carries neither.
  assert.doesNotMatch(
    html,
    /class="hdr"/,
    'the theme body has no header (the origin shell adds it)'
  );
  assert.doesNotMatch(
    html,
    /class="ftr"/,
    'the theme body has no footer (the origin shell adds it)'
  );
});
