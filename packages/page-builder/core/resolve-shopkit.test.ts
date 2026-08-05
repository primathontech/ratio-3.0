import { test } from 'node:test';
import assert from 'node:assert';
import { ShopkitResolver, commerceResolverFromEnv } from './resolve-shopkit';
import { DATA_SOURCE_TYPES } from './doc';
import type { ICommerceClient } from '@shopkit/data-layer';

// A canned custom-backend response in the real 2.0 shape: COLLECTION_BY_HANDLES → entries of
// { handle, data:{products} }, prices in PAISE, image as image_url or images[is_main], price on
// variants[0].price.amount or the product.price fallback.
function mockClient(collectionsResponse: unknown): ICommerceClient {
  return {
    getCollectionsByHandles: async () => collectionsResponse,
  } as unknown as ICommerceClient;
}

test('ShopkitResolver maps COLLECTION_BY_HANDLES → grid products (paise→rupees) + tags', async () => {
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
  assert.deepStrictEqual(products[0], {
    id: 'p1',
    title: 'Shoe A',
    href: '/products/shoe-a',
    image: 'https://img/a.jpg',
    price: 499, // 49900 paise → 499 rupees (from variants[0])
  });
  assert.strictEqual(products[1].price, 1299); // 129900 paise → 1299 (product.price fallback)
  assert.strictEqual(products[1].image, 'https://img/b.jpg'); // images[is_main].url
  assert.ok(tags.includes('col:summer'), 'collection tag');
  assert.ok(tags.includes('prod:p1'), 'per-product tags for purge');
});

test('ShopkitResolver maps a PRODUCT response into product + price bindings (paise→rupees)', async () => {
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
  const v = value as { product: { title: string; sku: string }; price: { amount: number } };
  assert.strictEqual(v.product.title, 'Shoe A');
  assert.strictEqual(v.product.sku, 'shoe-a');
  assert.strictEqual(v.price.amount, 499); // 49900 paise → 499 rupees
  assert.ok(tags.includes('prod:p1'));
});

test('commerceResolverFromEnv: null without platform URLs, a resolver with them', () => {
  assert.strictEqual(commerceResolverFromEnv({}), null);
  assert.ok(commerceResolverFromEnv({ COMMERCE_PRODUCT_API_URL: 'http://x' }));
});

test('per-tenant: a tenant with no commerce config gets no client → empty data (no crash/fetch)', async () => {
  const resolver = commerceResolverFromEnv({ COMMERCE_PRODUCT_API_URL: 'http://unused' })!;
  const out = await resolver.fetch(
    { type: DATA_SOURCE_TYPES.COLLECTION_BY_HANDLES, params: { handles: ['summer'] } },
    { tenantId: 't', commerce: null } // not connected to the backend
  );
  assert.deepStrictEqual(out, { value: {}, tags: [] });
});
