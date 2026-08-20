// Atelier — a full standalone luxury/editorial theme. It must be a VALID root theme (owns the whole
// document) and render its own home, collection, and product pages on the shared data contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { atelierBundleTheme } from '../theme/library/atelier-theme';
import { renderThemePage } from '../theme/theme-render';
import { StubResolver } from '../commerce/resolve';
import type { SectionRenderer } from '../theme/theme-render';

const theme: SectionRenderer = (liquid, data) => render(liquid, data, { trusted: true });
const renderPage = (page: string, routeParams: Record<string, string> = {}) =>
  renderThemePage(
    atelierBundleTheme(),
    page,
    { theme },
    { resolver: new StubResolver(), ctx: { tenantId: 't1', routeParams } }
  );

test('atelier is a valid root theme: owns the layout + chrome, all templates reference existing sections', () => {
  const files = atelierBundleTheme();
  assert.match(
    files['layout/theme.liquid'],
    /\{\{\s*content_for_layout\s*\}\}/,
    'owns the sections slot'
  );
  const templates = Object.keys(files).filter(
    (p) => p.startsWith('templates/') && p.endsWith('.json')
  );
  for (const t of templates) {
    const doc = JSON.parse(files[t]) as { sections: { type: string }[] };
    for (const s of doc.sections)
      assert.ok(
        files[`sections/${s.type}.liquid`] !== undefined,
        `${t} references sections/${s.type}.liquid`
      );
  }
  // Its own chrome + signature sections.
  for (const f of [
    'sections/header.liquid',
    'sections/footer.liquid',
    'sections/order.liquid',
    'sections/editorial-hero.liquid',
    'sections/feature.liquid',
  ]) {
    assert.ok(files[f], `ships ${f}`);
  }
});

test('atelier carries serif-heading / square tokens and its own stylesheet', () => {
  const files = atelierBundleTheme();
  const tokens = JSON.parse(files['config/tokens.json']) as { headingFont: string; radius: string };
  assert.equal(tokens.headingFont, 'serif');
  assert.equal(tokens.radius, 'square');
  assert.match(files['assets/base.css'], /\.hdr-brand\b/, 'ships its own header styles');
  assert.match(files['assets/base.css'], /\.ed-hero\b/, 'ships its editorial hero styles');
  // Mobile-first: no max-width MEDIA QUERIES (min-width only). (max-width as a CSS property is fine.)
  assert.doesNotMatch(
    files['assets/base.css'],
    /@media[^{]*max-width/,
    'no max-width media queries'
  );
  assert.match(
    files['assets/base.css'],
    /min-width:\s*64rem/,
    'uses min-width (Tailwind lg) breakpoints'
  );
});

test('atelier home renders its hero, the Edit product row, and the house feature', async () => {
  const { html } = await renderPage('index');
  assert.match(html, /class="ed-hero"/, 'the editorial hero renders');
  assert.match(html, /Quiet luxury, made to last/, 'the hero headline renders');
  assert.match(html, /The Edit/, 'the curated product row heading renders');
  assert.match(html, /class="rt feat"/, 'the house feature renders');
  assert.match(html, /Sample product 1/, 'products render');
  assert.match(html, /₹499\.00/, 'prices are formatted to rupees');
  assert.match(html, /action="\/cart\/add"/, 'each card has an add-to-bag form');
});

test('atelier ships its own header (centered wordmark) + footer newsletter', async () => {
  // Header/footer are chrome the origin renders separately (renderChrome), not part of a page template —
  // so render them directly with the chrome context (site_name / menu / footer) the origin passes.
  const files = atelierBundleTheme();
  const header = await render(
    files['sections/header.liquid'],
    { site_name: 'Atelier', menu: [{ title: 'New In', href: '/' }], footer: [] },
    { trusted: true }
  );
  assert.match(header, /class="hdr-brand"/, 'centered wordmark header');
  assert.match(header, /New In/, 'renders the store menu');
  const footer = await render(
    files['sections/footer.liquid'],
    {
      site_name: 'Atelier',
      footer: [{ title: 'Shop', href: '/', items: [{ title: 'New In', href: '/' }] }],
    },
    { trusted: true }
  );
  assert.match(footer, /class="ftr"/, 'its own footer');
  assert.match(footer, /Join the house list/, 'footer newsletter');
});

test('atelier collection + product pages render on the shared data', async () => {
  const c = await renderPage('collection', { handle: 'summer' });
  assert.match(c.html, /class="rt coll"/, 'its own collection layout');
  assert.match(c.html, /href="\/products\/sample-1"/, 'collection links to products');
  const p = await renderPage('product', { handle: 'air-max-90' });
  assert.match(p.html, /class="rt pdp"/, 'its own product layout');
  assert.match(p.html, /Sample: air-max-90/, 'product renders');
  assert.match(p.html, /Add to bag/, 'add to bag on the product page');
});
