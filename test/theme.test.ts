// Real theme renderer + content model (un-mock the theme). Pure, deterministic.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderPage } from '../packages/theme/index';
import { normalizePage } from '../packages/content-model/index';

const tenant = { name: 'Acme', theme: { color: '#c0392b' } };

test('renders a full HTML document with theme color + store name', () => {
  const html = renderPage({ sections: [{ kind: 'hero', heading: 'Big Sale' }] }, { tenant });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<style/);
  assert.match(html, /#c0392b/); // tenant accent applied
  assert.match(html, /Acme/); // store name in header/footer
  assert.match(html, /Big Sale/); // hero heading
});

test('renders a product-grid section', () => {
  const html = renderPage(
    {
      sections: [
        {
          kind: 'productGrid',
          products: [{ title: 'Red Shoe', price: 'Rs 1999', href: '/p/red' }],
        },
      ],
    },
    { tenant }
  );
  assert.match(html, /Red Shoe/);
  assert.match(html, /Rs 1999/);
});

test('renders a PDP with an add-to-cart control', () => {
  const html = renderPage(
    { sections: [{ kind: 'product', title: 'Red Shoe', price: 'Rs 1999' }] },
    { tenant }
  );
  assert.match(html, /Red Shoe/);
  assert.match(html, /add to cart/i);
});

test('escapes user text (no HTML injection via content)', () => {
  const html = renderPage(
    { sections: [{ kind: 'hero', heading: '<script>x</script>' }] },
    { tenant }
  );
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('normalizes legacy {title, body} into sections (backward-compat)', () => {
  const p = normalizePage({ title: 'Acme Home', body: 'Welcome to Acme' });
  assert.ok(Array.isArray(p.sections) && p.sections.length >= 1);
  assert.match(renderPage(p, { tenant }), /Welcome to Acme/);
});

test('normalizes legacy {title, price} into a product', () => {
  const p = normalizePage({ title: 'Red Shoe', price: 'Rs 1999' });
  assert.match(renderPage(p, { tenant }), /Rs 1999/);
  assert.match(renderPage(p, { tenant }), /add to cart/i);
});
