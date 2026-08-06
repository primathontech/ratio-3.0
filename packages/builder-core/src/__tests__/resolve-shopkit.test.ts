import { test } from 'node:test';
import assert from 'node:assert';
import { ShopkitResolver, commerceResolverFromEnv } from '../resolve-shopkit';
import { DATA_SOURCE_TYPES } from '../doc';
import type { ICommerceClient } from '@shopkit/data-layer';

// A canned custom-backend response in the real 2.0 shape: COLLECTION_BY_HANDLES → entries of
// { handle, data:{products} }, prices in PAISE, image as image_url or images[is_main], price on
// variants[0].price.amount or the product.price fallback.
function mockClient(collectionsResponse: unknown): ICommerceClient {
  return {
    getCollectionsByHandles: async () => collectionsResponse,
  } as unknown as ICommerceClient;
}

test('ShopkitResolver passes COLLECTION_BY_HANDLES products through UNMODIFIED + tags', async () => {
  const resp = {
    success: true,
    message: 'ok',
    data: [
      {
        handle: 'summer',
        data: {
          products: [
            {
              id: 'p1',
              handle: 'shoe-a',
              title: 'Shoe A',
              image_url: 'https://img/a.jpg',
              variants: [{ price: { amount: 49900 } }],
            },
            {
              id: 'p2',
              handle: 'shoe-b',
              title: 'Shoe B',
              images: [{ url: 'https://img/b.jpg', is_main: true }],
              price: 129900,
            },
          ],
        },
      },
    ],
  };
  const resolver = new ShopkitResolver(() => mockClient(resp));
  const { value, tags } = await resolver.fetch(
    { type: DATA_SOURCE_TYPES.COLLECTION_BY_HANDLES, params: { handles: ['summer'] } },
    { tenantId: 't', routeParams: { handle: 'summer' } }
  );
  const products = (value as { products: Record<string, unknown>[] }).products;
  assert.strictEqual(products.length, 2);
  // products pass through UNMODIFIED (canonical): raw paise, backend field names. The display
  // transform (paise→rupees, image pick, href) happens at RENDER, never here.
  assert.strictEqual(products[0].title, 'Shoe A');
  assert.strictEqual(products[0].handle, 'shoe-a'); // not reshaped to href
  assert.strictEqual(products[0].image_url, 'https://img/a.jpg'); // not reshaped to image
  assert.strictEqual(products[1].price, 129900); // raw paise, NOT converted
  assert.ok(tags.includes('col:summer'), 'collection tag');
  assert.ok(tags.includes('prod:p1'), 'per-product tags for purge');
});

test('ShopkitResolver passes the PRODUCT response through as the canonical product', async () => {
  const client = {
    getProduct: async () => ({
      success: true,
      message: 'ok',
      data: {
        id: 'p1',
        handle: 'shoe-a',
        title: 'Shoe A',
        description: 'A shoe.',
        variants: [{ price: { amount: 49900 } }],
      },
    }),
  } as unknown as ICommerceClient;
  const resolver = new ShopkitResolver(() => client);
  const { value, tags } = await resolver.fetch(
    { type: DATA_SOURCE_TYPES.PRODUCT, params: { handle: 'shoe-a' } },
    { tenantId: 't' }
  );
  const v = value as Record<string, unknown>;
  assert.strictEqual(v.title, 'Shoe A'); // canonical product passed through, unmodified
  assert.strictEqual(v.handle, 'shoe-a');
  assert.deepStrictEqual(v.variants, [{ price: { amount: 49900 } }]); // raw paise, not converted
  assert.ok(tags.includes('prod:p1'));
});

const ALL_URLS = {
  COMMERCE_PRODUCT_API_URL: 'http://x',
  COMMERCE_CART_API_URL: 'http://x',
  COMMERCE_ORDER_API_URL: 'http://x',
};

test('commerceResolverFromEnv: null without all platform URLs, a resolver with them', () => {
  assert.strictEqual(commerceResolverFromEnv({}), null);
  assert.strictEqual(commerceResolverFromEnv({ COMMERCE_PRODUCT_API_URL: 'http://x' }), null);
  assert.ok(commerceResolverFromEnv(ALL_URLS));
});

test('per-tenant: a tenant with no commerce config gets no client → empty data (no crash/fetch)', async () => {
  const resolver = commerceResolverFromEnv(ALL_URLS)!;
  const out = await resolver.fetch(
    { type: DATA_SOURCE_TYPES.COLLECTION_BY_HANDLES, params: { handles: ['summer'] } },
    { tenantId: 't', commerce: null } // not connected to the backend
  );
  assert.deepStrictEqual(out, { value: {}, tags: [] });
});
