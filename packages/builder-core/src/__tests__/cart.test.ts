// Server-side cart (no-JS storefront): the service maps the backend response, ensures/creates a
// cart, and the cookie + cart page render correctly. The commerce backend is faked (IResponse
// envelope), same contract R2's DataLayerCartService used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CartService,
  readCartToken,
  cartCookie,
  renderCartPage,
  emptyCart,
  type CartBackend,
  type Cart,
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

test('remove sets quantity 0 via updateCart (gokwik idiom); a failed op throws', async () => {
  let sent: unknown;
  const svc = new CartService(
    fakeBackend({
      updateCart: async (p) => {
        sent = p.items;
        return ok(emptyGk());
      },
    })
  );
  const cart = await svc.remove('81bdbe9b', ['v1']);
  assert.deepEqual(sent, [{ variantId: 'v1', quantity: 0 }]);
  assert.equal(cart.count, 0);
  await assert.rejects(() =>
    new CartService(fakeBackend({ updateCart: fail })).remove('t', ['v1'])
  );
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

test('renderCartPage: empty state', () => {
  const html = renderCartPage(emptyCart(), { siteName: 'Acme', styleHead: '<style></style>' });
  assert.match(html, /Your cart is empty/);
  assert.match(html, /<title>Cart · Acme<\/title>/);
});

test('renderCartPage: lines, subtotal, GoKwik checkout handoff, chrome, escaping', () => {
  const cart: Cart = {
    id: 'c1',
    count: 2,
    subtotal: 558,
    checkoutUrl: 'https://gk/checkout/c1',
    items: [{ id: 'v1', title: '<b>Shampoo</b>', quantity: 2, price: 279 }],
  };
  const html = renderCartPage(cart, {
    siteName: 'Acme',
    styleHead: '',
    header: '<header>H</header>',
    footer: '<footer>F</footer>',
  });
  assert.match(html, /&lt;b&gt;Shampoo&lt;\/b&gt;/); // title escaped
  assert.match(html, /Qty 2/);
  assert.match(html, /₹558\.00/); // subtotal (and line sum 279×2)
  assert.match(html, /href="https:\/\/gk\/checkout\/c1"[^>]*>Checkout</); // checkout → GoKwik
  assert.match(html, /<header>H<\/header>/);
  assert.match(html, /<footer>F<\/footer>/);
});

test('renderCartPage: no checkoutUrl → checkout is disabled, not broken', () => {
  const cart: Cart = {
    id: 'c1',
    count: 1,
    subtotal: 279,
    items: [{ id: 'l1', title: 'X', quantity: 1, price: 279 }],
  };
  const html = renderCartPage(cart, { siteName: 'Acme', styleHead: '' });
  assert.doesNotMatch(html, /cart-checkout/);
  assert.match(html, /Checkout isn't available yet/);
});
