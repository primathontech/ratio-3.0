import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductSeo, isFilteredUrl, metaText } from '../extract';

test('extractProductSeo honours the merchant SEO override chain (seo_title → seo.title → title)', () => {
  assert.equal(extractProductSeo({ seo_title: 'A', title: 'B' }).title, 'A');
  assert.equal(extractProductSeo({ seo: { title: 'A' }, title: 'B' }).title, 'A');
  assert.equal(extractProductSeo({ title: 'B', name: 'C' }).title, 'B');
  assert.equal(extractProductSeo({ name: 'C' }).title, 'C');
});

test('extractProductSeo reads price from variants[0].price.amount, then the top-level fallback', () => {
  assert.equal(extractProductSeo({ variants: [{ price: { amount: 49900 } }] }).priceMinor, 49900);
  assert.equal(extractProductSeo({ price: 129900 }).priceMinor, 129900);
  // a variant with no amount does not shadow the top-level fallback
  assert.equal(extractProductSeo({ variants: [{}], price: 500 }).priceMinor, 500);
  assert.equal(extractProductSeo({ title: 'x' }).priceMinor, undefined);
});

test('extractProductSeo collects absolute images, is_main first, deduped; drops relative/blank', () => {
  assert.deepEqual(
    extractProductSeo({
      image_url: 'https://img/a.jpg',
      images: [{ url: 'https://img/a.jpg' }, { url: 'https://img/b.jpg', is_main: true }],
    }).images,
    ['https://img/b.jpg', 'https://img/a.jpg']
  );
  assert.deepEqual(extractProductSeo({ image_url: '/rel.jpg' }).images, []);
  assert.deepEqual(extractProductSeo({ image: { url: 'https://img/c.jpg' } }).images, [
    'https://img/c.jpg',
  ]);
});

test('extractProductSeo passes through commerce fields (available/sku/brand/gtin|barcode/currency)', () => {
  const f = extractProductSeo({
    title: 'x',
    available: false,
    sku: 'SKU1',
    brand: 'Acme',
    barcode: '12345678',
    currency: 'USD',
  });
  assert.equal(f.available, false);
  assert.equal(f.sku, 'SKU1');
  assert.equal(f.brand, 'Acme');
  assert.equal(f.gtin, '12345678'); // barcode → gtin
  assert.equal(f.currency, 'USD');
});

test('isFilteredUrl matches facet/sort/pagination params only', () => {
  assert.ok(isFilteredUrl('?sort_by=price'));
  assert.ok(isFilteredUrl('?filter.color=red'));
  assert.ok(isFilteredUrl('?page=2'));
  assert.ok(!isFilteredUrl('?utm_source=x'), 'a plain share param stays indexable');
  assert.ok(!isFilteredUrl(''));
});

test('metaText strips HTML, collapses whitespace, truncates ~160 with an ellipsis', () => {
  assert.equal(metaText('<p>A  <b>great</b>\n shoe.</p>'), 'A great shoe.');
  const long = metaText('x'.repeat(300));
  assert.ok(long.length <= 160 && long.endsWith('…'));
});
