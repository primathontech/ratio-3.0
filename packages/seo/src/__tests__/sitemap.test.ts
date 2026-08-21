import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotsTxt, sitemapXml } from '../sitemap';
import { productBreadcrumbs, collectionBreadcrumbs } from '../breadcrumbs';

test('robotsTxt allows crawling, blocks transactional/API routes, links the sitemap', () => {
  const r = robotsTxt('https://shop.example');
  assert.match(r, /User-agent: \*/);
  assert.match(r, /Allow: \//);
  for (const d of ['/cart', '/checkout', '/account', '/api/'])
    assert.ok(r.includes(`Disallow: ${d}`), `blocks ${d}`);
  assert.ok(r.includes('Sitemap: https://shop.example/sitemap.xml'));
});

test('sitemapXml: valid urlset, joins origin, dedupes by path, XML-escapes <loc>', () => {
  const xml = sitemapXml('https://shop.example', [
    '/',
    '/collections/shoes',
    '/collections/shoes', // dup dropped
    '/products/a&b',
  ]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.includes('<loc>https://shop.example/</loc>'));
  assert.equal((xml.match(/\/collections\/shoes</g) ?? []).length, 1, 'duplicate dropped');
  assert.ok(xml.includes('<loc>https://shop.example/products/a&amp;b</loc>'), 'loc XML-escaped');
});

test('sitemapXml: SitemapEntry records emit lastmod/changefreq/priority', () => {
  const xml = sitemapXml('https://shop.example', [
    { path: '/', priority: 1, changeFrequency: 'daily' },
    { path: '/products/x', lastModified: '2026-08-01', priority: 0.8 },
  ]);
  assert.ok(xml.includes('<priority>1.0</priority>'));
  assert.ok(xml.includes('<changefreq>daily</changefreq>'));
  assert.ok(xml.includes('<lastmod>2026-08-01</lastmod>'));
  assert.ok(xml.includes('<priority>0.8</priority>'));
});

test('productBreadcrumbs: Home → humanised collection (nested route) → product', () => {
  const crumbs = productBreadcrumbs(
    'https://shop.example',
    '/collections/summer-sale/products/blue-shoe',
    'Blue Shoe'
  );
  assert.deepEqual(crumbs, [
    { name: 'Home', url: 'https://shop.example' },
    { name: 'Summer Sale', url: 'https://shop.example/collections/summer-sale' },
    { name: 'Blue Shoe', url: 'https://shop.example/collections/summer-sale/products/blue-shoe' },
  ]);
});

test('productBreadcrumbs: a flat /products/:handle route has no collection crumb', () => {
  const crumbs = productBreadcrumbs('https://shop.example', '/products/blue-shoe', 'Blue Shoe');
  assert.equal(crumbs.length, 2);
  assert.equal(crumbs[1].name, 'Blue Shoe');
});

test('collectionBreadcrumbs: Home → collection', () => {
  assert.deepEqual(collectionBreadcrumbs('https://shop.example', '/collections/shoes', 'Shoes'), [
    { name: 'Home', url: 'https://shop.example' },
    { name: 'Shoes', url: 'https://shop.example/collections/shoes' },
  ]);
});
