import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  productSchema,
  collectionSchema,
  organizationSchema,
  websiteSchema,
  breadcrumbSchema,
  validateSchema,
} from '../structured-data';

const config = { siteName: 'Acme', siteUrl: 'https://shop.example' };

test('productSchema: paise→rupees offer, INR default, brand=siteName, seller, itemCondition', () => {
  const s = productSchema(
    {
      name: 'Blue Shoe',
      url: 'https://shop.example/products/blue-shoe',
      images: ['https://cdn/a.jpg', 'https://cdn/b.jpg'],
      priceMinor: 49900,
      sku: 'SKU1',
      gtin: '12345678',
    },
    config
  );
  assert.equal(s['@type'], 'Product');
  assert.equal(s.name, 'Blue Shoe');
  assert.deepEqual(s.image, ['https://cdn/a.jpg', 'https://cdn/b.jpg']);
  assert.equal(s.sku, 'SKU1');
  assert.equal(s.gtin, '12345678');
  assert.deepEqual(s.brand, { '@type': 'Brand', name: 'Acme' });
  assert.deepEqual(s.offers, {
    '@type': 'Offer',
    url: 'https://shop.example/products/blue-shoe',
    price: '499.00',
    priceCurrency: 'INR',
    availability: 'https://schema.org/InStock',
    itemCondition: 'https://schema.org/NewCondition',
    seller: { '@type': 'Organization', name: 'Acme' },
  });
});

test('productSchema: available:false → OutOfStock; no price → no offers; explicit brand wins', () => {
  const oos = productSchema(
    {
      name: 'X',
      url: 'https://shop.example/products/x',
      images: [],
      priceMinor: 100,
      available: false,
      brand: 'Nike',
    },
    config
  );
  assert.equal(
    (oos.offers as Record<string, unknown>).availability,
    'https://schema.org/OutOfStock'
  );
  assert.deepEqual(oos.brand, { '@type': 'Brand', name: 'Nike' });

  const noPrice = productSchema(
    { name: 'X', url: 'https://shop.example/products/x', images: [] },
    config
  );
  assert.ok(!('offers' in noPrice));
  assert.ok(!('image' in noPrice), 'empty image array omitted');
});

test('collectionSchema: CollectionPage with an ItemList of the first products', () => {
  const s = collectionSchema(
    {
      name: 'Shoes',
      url: 'https://shop.example/collections/shoes',
      products: [{ title: 'A', handle: 'a', image: 'https://cdn/a.jpg' }],
    },
    config
  );
  assert.equal(s['@type'], 'CollectionPage');
  const list = s.mainEntity as {
    '@type': string;
    numberOfItems: number;
    itemListElement: Array<{ item: { url: string } }>;
  };
  assert.equal(list['@type'], 'ItemList');
  assert.equal(list.numberOfItems, 1);
  assert.equal(list.itemListElement[0].item.url, 'https://shop.example/products/a');
});

test('website + organization schemas carry name + url (no SearchAction until search ships)', () => {
  const w = websiteSchema(config);
  assert.equal(w['@type'], 'WebSite');
  assert.ok(!('potentialAction' in w), 'no SearchAction to a missing /search endpoint');
  assert.equal(organizationSchema(config)['@type'], 'Organization');
});

test('breadcrumbSchema builds an ordered ListItem trail; null when empty', () => {
  const s = breadcrumbSchema([
    { name: 'Home', url: 'https://shop.example' },
    { name: 'Shoe', url: 'https://shop.example/products/shoe' },
  ])!;
  assert.equal(s['@type'], 'BreadcrumbList');
  assert.equal((s.itemListElement as Array<{ position: number }>)[1].position, 2);
  assert.equal(breadcrumbSchema([]), null);
});

test('validateSchema deep-strips undefined/null keys', () => {
  const cleaned = validateSchema({
    '@context': 'x',
    '@type': 'Product',
    name: 'A',
    extra: undefined,
  });
  assert.ok(!('extra' in cleaned));
});
