import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSeoHead } from '../head';
import { productSchema, breadcrumbSchema } from '../structured-data';
import { jsonLdScript } from '../escape';

const base = {
  url: 'https://shop.example/products/blue-shoe',
  canonicalUrl: 'https://shop.example/products/blue-shoe',
  siteName: 'Acme',
};

test('renderSeoHead: canonical + core Open Graph on a plain page (no entity layer)', () => {
  const h = renderSeoHead({
    url: 'https://shop.example/',
    canonicalUrl: 'https://shop.example/',
    siteName: 'Acme',
  });
  assert.ok(h.includes('<link rel="canonical" href="https://shop.example/">'));
  assert.ok(h.includes('<meta property="og:site_name" content="Acme">'));
  assert.ok(h.includes('<meta property="og:type" content="website">'));
  assert.ok(h.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(!h.includes('og:title'));
  assert.ok(!h.includes('name="description"'));
  assert.ok(!h.includes('application/ld+json'));
});

test('renderSeoHead: facet/sort/pagination URL is noindex,follow; a share param stays indexable', () => {
  const filtered = renderSeoHead({
    url: 'https://shop.example/collections/shoes?filter.color=red',
    canonicalUrl: 'https://shop.example/collections/shoes',
    siteName: 'Acme',
  });
  assert.ok(filtered.includes('<meta name="robots" content="noindex,follow">'));
  assert.ok(
    filtered.includes('<link rel="canonical" href="https://shop.example/collections/shoes">'),
    'canonical drops the query'
  );
  const utm = renderSeoHead({
    url: 'https://shop.example/c?utm_source=x',
    canonicalUrl: 'https://shop.example/c',
    siteName: 'Acme',
  });
  assert.ok(!utm.includes('noindex'));
});

test('renderSeoHead: a product emits og:type/title/description/image + a <script> per JSON-LD item', () => {
  const h = renderSeoHead({
    ...base,
    title: 'Blue Shoe',
    description: '<p>A <b>great</b> shoe.</p>',
    imageUrl: 'https://cdn/a.jpg',
    type: 'product',
    jsonLd: [
      productSchema(
        {
          name: 'Blue Shoe',
          url: base.canonicalUrl,
          images: ['https://cdn/a.jpg'],
          priceMinor: 49900,
        },
        { siteName: 'Acme', siteUrl: 'https://shop.example' }
      ),
      breadcrumbSchema([{ name: 'Home', url: 'https://shop.example' }]),
    ],
  });
  assert.ok(h.includes('<meta property="og:type" content="product">'));
  assert.ok(h.includes('<meta property="og:title" content="Blue Shoe">'));
  assert.ok(h.includes('<meta name="description" content="A great shoe.">'), 'HTML stripped');
  assert.ok(h.includes('<meta property="og:image" content="https://cdn/a.jpg">'));
  assert.equal((h.match(/application\/ld\+json/g) ?? []).length, 2, 'one script per schema');
  assert.ok(h.includes('"@type":"Product"'));
  assert.ok(h.includes('"@type":"BreadcrumbList"'));
});

test('renderSeoHead: a null JSON-LD item (empty breadcrumb) is skipped', () => {
  const h = renderSeoHead({ ...base, jsonLd: [null, breadcrumbSchema([])] });
  assert.ok(!h.includes('application/ld+json'));
});

test('renderSeoHead is total: a malformed url does not throw (no facet-noindex, canonical passed through)', () => {
  const h = renderSeoHead({
    url: 'not a url',
    canonicalUrl: 'https://shop.example/',
    siteName: 'Acme',
  });
  assert.ok(!h.includes('noindex'), 'unparseable url → treated as no facet params');
  assert.ok(h.includes('<link rel="canonical" href="https://shop.example/">'));
});

test('a crafted title/site name cannot inject markup into the head', () => {
  const h = renderSeoHead({ ...base, siteName: 'A & "B" <x>', title: '"><script>x</script>' });
  assert.ok(!h.includes('<script>x'), 'no raw markup from the title');
  assert.ok(h.includes('content="A &amp; &quot;B&quot; &lt;x&gt;"'));
});

test('jsonLdScript escapes < so an entity field cannot break out of the <script>', () => {
  const s = jsonLdScript({ name: '</script><script>alert(1)</script>' });
  assert.ok(!s.includes('</script><script>'));
  assert.ok(s.includes('\\u003c/script'));
  assert.equal((s.match(/<\/script>/g) ?? []).length, 1, 'exactly one real closing tag');
});
