import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seoHead } from '../storefront/seo';

test('seoHead emits a clean canonical (query dropped) + core Open Graph', () => {
  const h = seoHead({
    url: 'https://shop.example/collections/shoes?sort_by=price',
    siteName: 'My Shop',
  });
  assert.ok(h.includes('<link rel="canonical" href="https://shop.example/collections/shoes">'));
  assert.ok(!h.includes('sort_by'), 'canonical drops the query string');
  assert.ok(
    h.includes('<meta property="og:url" content="https://shop.example/collections/shoes">')
  );
  assert.ok(h.includes('<meta property="og:site_name" content="My Shop">'));
  assert.ok(h.includes('<meta property="og:type" content="website">'));
  assert.ok(h.includes('<meta name="twitter:card" content="summary_large_image">'));
});

test('a filtered/sorted/paginated URL is noindex,follow (kept out of the index)', () => {
  const filtered = seoHead({
    url: 'https://shop.example/collections/shoes?filter.color=red',
    siteName: 'S',
  });
  assert.ok(filtered.includes('<meta name="robots" content="noindex,follow">'));
  const clean = seoHead({ url: 'https://shop.example/collections/shoes', siteName: 'S' });
  assert.ok(!clean.includes('noindex'), 'a clean URL stays indexable');
});

test('a trailing/double slash canonicalizes to the same URL (no duplicate content)', () => {
  const canon = 'https://shop.example/collections/shoes';
  for (const variant of ['/collections/shoes/', '/collections/shoes', '//collections//shoes/']) {
    const h = seoHead({ url: `https://shop.example${variant}`, siteName: 'S' });
    assert.ok(h.includes(`<link rel="canonical" href="${canon}">`), `${variant} → ${canon}`);
  }
});

test('a crafted path cannot inject markup into the canonical/og attributes', () => {
  const h = seoHead({ url: 'https://shop.example/a"><script>x</script>', siteName: 'S' });
  assert.ok(!h.includes('<script>'), 'no raw markup reaches the head');
  assert.ok(!/href="[^"]*"[^>]*><script/.test(h), 'no attribute breakout');
});

test('site name is attribute-escaped (no markup injection via the store name)', () => {
  const h = seoHead({ url: 'https://shop.example/', siteName: 'A & B "Co" <x>' });
  assert.ok(h.includes('content="A &amp; B &quot;Co&quot; &lt;x&gt;"'));
  assert.ok(!h.includes('<x>'), 'raw markup from the name never lands in the head');
});
