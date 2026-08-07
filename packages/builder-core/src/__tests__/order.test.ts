import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService, renderAccountPage, type OrderBackend } from '../order';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ok = (data: unknown) => ({ success: true, message: 'ok', data }) as any;
const fail = () => ({ success: false, message: 'nope', data: null }) as any;

function backend(res: unknown): OrderBackend {
  return { getOrderHistory: async () => res as any };
}

test('OrderService.history maps data.orders[].order → canonical; [] on no token / failure', async () => {
  const res = ok({
    orders: [
      {
        order: {
          orderName: 'ordr_1',
          total_price: 351,
          financial_status: 'paid',
          items: [{ title: 'Shampoo', quantity: 2, price: 311 }],
        },
      },
    ],
  });
  const orders = await new OrderService(backend(res)).history('tok');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, 'ordr_1');
  assert.equal(orders[0].total, 351);
  assert.equal(orders[0].status, 'paid');
  assert.deepEqual(orders[0].items, [{ title: 'Shampoo', quantity: 2, price: 311 }]);

  assert.deepEqual(await new OrderService(backend(res)).history(''), []); // no token → no call
  assert.deepEqual(await new OrderService(backend(fail())).history('tok'), []); // failure → []
});

test('renderAccountPage: logged-out shows the login CTA (#rt-login), no order list', () => {
  const html = renderAccountPage(
    { loggedIn: false, orders: [] },
    { siteName: 'Acme', styleHead: '' }
  );
  assert.match(html, /<title>Account · Acme<\/title>/);
  assert.match(html, /Log in to see your orders/);
  assert.match(html, /id="rt-login"/);
  assert.doesNotMatch(html, /id="rt-logout"/);
});

test('renderAccountPage: logged-in renders orders + items + logout; escapes titles', () => {
  const html = renderAccountPage(
    {
      loggedIn: true,
      orders: [
        {
          id: 'ordr_1',
          total: 351,
          status: 'paid',
          items: [{ title: '<b>Shampoo</b>', quantity: 2, price: 311 }],
        },
      ],
    },
    { siteName: 'Acme', styleHead: '', header: '<header>H</header>' }
  );
  assert.match(html, /id="rt-logout"/);
  assert.match(html, />ordr_1</);
  assert.match(html, /&lt;b&gt;Shampoo&lt;\/b&gt; × 2/); // escaped title + qty
  assert.match(html, /₹622\.00/); // 311 × 2
  assert.match(html, /₹351\.00/); // order total
  assert.match(html, /<header>H<\/header>/);
});

test('renderAccountPage: logged-in but no orders → empty message, still has logout', () => {
  const html = renderAccountPage(
    { loggedIn: true, orders: [] },
    { siteName: 'Acme', styleHead: '' }
  );
  assert.match(html, /no orders yet/);
  assert.match(html, /id="rt-logout"/);
});
