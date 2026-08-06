import { test } from 'node:test';
import assert from 'node:assert';
import { matchRoute } from '../router';

test('home → self-keyed home doc', () => {
  assert.deepStrictEqual(matchRoute('/'), {
    templateKey: '/', // self: the home doc lives at '/'
    pageType: 'home',
    params: {},
  });
});

test('static page → self-keyed page doc at the concrete path', () => {
  assert.deepStrictEqual(matchRoute('/pages/about-us'), {
    templateKey: '/pages/about-us', // self: each page is its own doc
    pageType: 'page',
    params: { handle: 'about-us' },
  });
});

test('unknown paths do not match (exact-page lane / 404 handles them)', () => {
  assert.strictEqual(matchRoute('/about'), null); // not under /pages/
  assert.strictEqual(matchRoute('/collections'), null); // no handle segment
  assert.strictEqual(matchRoute('/collections/'), null); // empty handle
});

test('collection URL → collection template + handle param', () => {
  assert.deepStrictEqual(matchRoute('/collections/summer'), {
    templateKey: '/collections/:handle',
    pageType: 'collection',
    params: { handle: 'summer' },
  });
});

test('product URL → product template + handle param', () => {
  assert.deepStrictEqual(matchRoute('/products/air-max-90'), {
    templateKey: '/products/:handle',
    pageType: 'product',
    params: { handle: 'air-max-90' },
  });
});

test('nested product URL → the SAME product template, with collection context', () => {
  assert.deepStrictEqual(matchRoute('/collections/summer/products/air-max-90'), {
    templateKey: '/products/:handle',
    pageType: 'product',
    params: { collection: 'summer', handle: 'air-max-90' },
  });
});

test('params are percent-decoded', () => {
  assert.deepStrictEqual(matchRoute('/collections/summer%20sale')?.params, {
    handle: 'summer sale',
  });
});

test('extra path depth does not match', () => {
  assert.strictEqual(matchRoute('/collections/a/b'), null);
  assert.strictEqual(matchRoute('/products/a/b'), null);
});
