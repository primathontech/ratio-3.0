// Server-side cart (no-JS storefront): the service maps the backend response, ensures/creates a
// cart, and the cookie + cart page render correctly. The commerce backend is faked (IResponse
// envelope), same contract R2's DataLayerCartService used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CartService,
  readCartToken,
  cartCookie,
  expireCartCookie,
  renderOrderPage,
  type CartBackend,
} from '../cart';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ok = (data: unknown) => ({ success: true, message: 'ok', data }) as any;
const fail = () => ({ success: false, message: 'nope', data: null }) as any;

// A gokwik-shaped cart response: token is the durable id, prices in paise, `id` is the line key.
const gkCart = (over: Record<string, unknown> = {}) => ({
  token: '81bdbe9b',
  id: 'cart_178',
  item_count: 2,
  items_subtotal_price: 55800,
  items: [
    {
      id: '3276',
      title: 'Shampoo',
      quantity: 2,
      final_price: 27900,
      image: 'x.jpg',
      variant_id: 'v1',
    },
  ],
  ...over,
});
const emptyGk = () => gkCart({ items: [], item_count: 0, items_subtotal_price: 0 });

function fakeBackend(overrides: Partial<CartBackend> = {}): CartBackend {
  return {
    createCart: async () => ok(emptyGk()),
    getCart: async ({ id }: { id: string }) => ok(gkCart({ token: id })),
    addToCart: async ({ id }: { id: string }) => ok(gkCart({ token: id || 'fresh-token' })),
    removeFromCart: async () => ok(emptyGk()),
    updateCart: async () => ok(gkCart()),
    ...overrides,
  };
}

test('get maps a gokwik cart → canonical (token id, paise→rupees, line key, item_count)', async () => {
  const cart = await new CartService(fakeBackend()).get('81bdbe9b');
  assert.equal(cart.id, '81bdbe9b'); // the token, not the numeric cart_178 id
  assert.equal(cart.count, 2);
  assert.equal(cart.items[0].title, 'Shampoo');
  assert.equal(cart.items[0].id, 'v1'); // line key = variant_id (the id used to mutate the line)
  assert.equal(cart.items[0].price, 279); // 27900 paise → ₹279
  assert.equal(cart.subtotal, 558); // 55800 paise → ₹558
});

test('add bootstraps via createCart when there is no token, and reuses the token when present', async () => {
  let creates = 0;
  let addId = 'unset';
  const svc = new CartService(
    fakeBackend({
      createCart: async () => {
        creates++;
        return ok(gkCart({ token: 'fresh-token', items: [], item_count: 0 }));
      },
      addToCart: async ({ id }) => {
        addId = id;
        return ok(gkCart({ token: id }));
      },
    })
  );
  const created = await svc.add(null, [{ variantId: 'v1', quantity: 1 }]);
  assert.equal(creates, 1); // no token → mint a cart first
  assert.equal(addId, 'fresh-token'); // then add to the new token
  assert.equal(created.id, 'fresh-token'); // returns the token to persist

  const reused = await svc.add('81bdbe9b', [{ variantId: 'v1', quantity: 1 }]);
  assert.equal(creates, 1); // token present → no extra createCart
  assert.equal(addId, '81bdbe9b');
  assert.equal(reused.id, '81bdbe9b');
});

test('setQuantity re-sends the full line set with just the target changed (min 1)', async () => {
  let sent: unknown;
  const svc = new CartService(
    fakeBackend({
      // current cart has two lines: v1 (qty 2) and v2 (qty 5)
      getCart: async () =>
        ok(
          gkCart({
            items: [
              { id: 'x', variant_id: 'v1', title: 'A', quantity: 2, final_price: 10000 },
              { id: 'y', variant_id: 'v2', title: 'B', quantity: 5, final_price: 20000 },
            ],
          })
        ),
      updateCart: async (p) => {
        sent = p.items;
        return ok(emptyGk());
      },
    })
  );
  await svc.setQuantity('81bdbe9b', 'v1', 3);
  assert.deepEqual(sent, [
    { variantId: 'v1', quantity: 3 }, // target changed
    { variantId: 'v2', quantity: 5 }, // others preserved
  ]);
  // qty floored at 1 (removing a line entirely is a separate op)
  const svc2 = new CartService(
    fakeBackend({
      getCart: async () =>
        ok(gkCart({ items: [{ variant_id: 'v1', title: 'A', quantity: 2, final_price: 10000 }] })),
      updateCart: async (p) => {
        sent = p.items;
        return ok(emptyGk());
      },
    })
  );
  await svc2.setQuantity('81bdbe9b', 'v1', 0);
  assert.deepEqual(sent, [{ variantId: 'v1', quantity: 1 }]);
});

test('remove calls removeFromCart by variant id; a failed op throws', async () => {
  let sent: unknown;
  const svc = new CartService(
    fakeBackend({
      removeFromCart: async (p) => {
        sent = p.itemIds;
        return ok(emptyGk());
      },
    })
  );
  await svc.remove('81bdbe9b', ['v1']);
  assert.deepEqual(sent, ['v1']);
  await assert.rejects(() =>
    new CartService(fakeBackend({ removeFromCart: fail })).remove('t', ['v1'])
  );
});

test('resolveVariant: handle → first variant id; empty when no lookup / no variants / failure', async () => {
  const withProduct = (product: unknown): CartBackend =>
    fakeBackend({ getProduct: async () => ok(product) });
  // gokwik product/details shape: data.variants[0].id is the variant to add
  assert.equal(
    await new CartService(withProduct({ variants: [{ id: '42729391128654' }] })).resolveVariant(
      'h'
    ),
    '42729391128654'
  );
  // nested under data.product, keyed by variant_id
  assert.equal(
    await new CartService(
      withProduct({ product: { variants: [{ variant_id: 'v9' }] } })
    ).resolveVariant('h'),
    'v9'
  );
  // no getProduct on the backend → '' (caller skips the add rather than sending a bogus id)
  assert.equal(await new CartService(fakeBackend()).resolveVariant('h'), '');
  // no variants / failed lookup → ''
  assert.equal(await new CartService(withProduct({ variants: [] })).resolveVariant('h'), '');
  assert.equal(await new CartService(fakeBackend({ getProduct: fail })).resolveVariant('h'), '');
  assert.equal(
    await new CartService(withProduct({ variants: [{ id: 'x' }] })).resolveVariant(''),
    ''
  );
});

test('createCheckout: token → merchantCheckoutId; empty when no backend method / no token', async () => {
  let sentPayload: unknown;
  const withCheckout = new CartService(
    fakeBackend({
      createCheckout: async (p) => {
        sentPayload = p.payload;
        return ok({ id: 'chk_123' });
      },
    })
  );
  assert.equal(await withCheckout.createCheckout('81bdbe9b'), 'chk_123');
  assert.deepEqual(sentPayload, { cart_token: '81bdbe9b', checkout_id: '' });
  // no createCheckout on the backend → '' (checkout stays unavailable, no crash)
  assert.equal(await new CartService(fakeBackend()).createCheckout('t'), '');
  // no token → ''
  assert.equal(await withCheckout.createCheckout(''), '');
});

test('readCartToken parses the cart cookie; cartCookie is httpOnly + scoped', () => {
  assert.equal(readCartToken('a=1; rt_cart=tok%20en; b=2'), 'tok en');
  assert.equal(readCartToken('other=x'), null);
  assert.equal(readCartToken(undefined), null);
  const c = cartCookie('t1');
  assert.match(c, /^rt_cart=t1;/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
});

test('expireCartCookie clears rt_cart (Max-Age 0, httpOnly)', () => {
  const c = expireCartCookie();
  assert.match(c, /^rt_cart=;/);
  assert.match(c, /Max-Age=0/);
  assert.match(c, /HttpOnly/);
});

test('renderOrderPage: thank-you with order id/total/payment, chrome, escaping', () => {
  const html = renderOrderPage(
    { id: 'ord_<1>', total: 279, paymentMethod: 'UPI' },
    { siteName: 'Acme', styleHead: '', header: '<header>H</header>', footer: '<footer>F</footer>' }
  );
  assert.match(html, /Thank you!/);
  assert.match(html, /<title>Order confirmed · Acme<\/title>/);
  assert.match(html, /ord_&lt;1&gt;/); // id escaped
  assert.match(html, /₹279\.00/);
  assert.match(html, />UPI</);
  assert.match(html, /<header>H<\/header>/);
  assert.match(html, /<footer>F<\/footer>/);
});

test('renderOrderPage: omits rows that are absent (only id → no total/payment rows)', () => {
  const html = renderOrderPage({ id: 'o1' }, { siteName: 'Acme', styleHead: '' });
  assert.match(html, />o1</);
  assert.doesNotMatch(html, /Total<\/span>/);
  assert.doesNotMatch(html, /Payment<\/span>/);
});

// The cart PAGE was removed (OFCE): the GoKwik side-cart widget (loaded on every page) is the cart —
// it intercepts add-to-cart and opens its drawer itself. There is no renderCartPage to test here.
