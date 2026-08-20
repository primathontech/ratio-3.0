// The Editorial base must be a VALID root theme (owns the whole document) and render its distinctive
// home — same render contract the Default base is held to, so a store adopting Editorial works too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { atelierBundleTheme } from '../theme/atelier-theme';
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

test('editorial base is a valid root theme: owns the layout, all templates reference existing sections', () => {
  const files = atelierBundleTheme();
  assert.match(
    files['layout/theme.liquid'],
    /\{\{\s*content_for_layout\s*\}\}/,
    'owns the sections slot'
  );
  // Its own distinctive sections + shared chrome must all resolve to files.
  const templates = Object.keys(files).filter(
    (p) => p.startsWith('templates/') && p.endsWith('.json')
  );
  for (const t of templates) {
    const doc = JSON.parse(files[t]) as { sections: { type: string }[] };
    for (const s of doc.sections) {
      assert.ok(
        files[`sections/${s.type}.liquid`] !== undefined,
        `${t} references sections/${s.type}.liquid`
      );
    }
  }
  assert.ok(files['sections/editorial-hero.liquid'], 'ships its editorial-hero section');
  assert.ok(files['sections/feature.liquid'], 'ships its feature section');
});

test('editorial base carries serif + square tokens and its section styles atop the shared base.css', () => {
  const files = atelierBundleTheme();
  const tokens = JSON.parse(files['config/tokens.json']) as { bodyFont: string; radius: string };
  assert.equal(tokens.bodyFont, 'serif');
  assert.equal(tokens.radius, 'square');
  assert.match(files['assets/base.css'], /\.hdr\b/, 'keeps the shared chrome classes');
  assert.match(files['assets/base.css'], /\.ed-hero\b/, 'adds the editorial section styles');
});

test('editorial home renders the editorial hero, feature, and a product row with rupee prices', async () => {
  const { html } = await renderPage('index');
  assert.match(html, /class="ed-hero"/, 'the editorial hero renders');
  assert.match(html, /Made to be lived in/, 'the hero headline renders');
  assert.match(html, /class="rt feat"/, 'the split feature renders');
  assert.match(html, /<h2 class="heading">The edit<\/h2>/, 'the curated product row renders');
  assert.match(html, /Sample product 1/, 'products render');
  assert.match(html, /₹499\.00/, 'prices are formatted to rupees');
  // Distinct from the default home — no promo carousel here.
  assert.doesNotMatch(html, /class="slideshow"/, 'the editorial home has no promo carousel');
});

test('editorial base reuses the shared collection + product pages', async () => {
  const c = await renderPage('collection', { handle: 'summer' });
  assert.match(c.html, /href="\/products\/sample-1"/, 'collection page works');
  const p = await renderPage('product', { handle: 'air-max-90' });
  assert.match(p.html, /Sample: air-max-90/, 'product page works');
});
