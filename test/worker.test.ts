// The edge->origin URL join must not double-slash when ORIGIN_URL has a trailing "/".
import { test } from 'node:test';
import assert from 'node:assert';
import { originTarget, proxyInit, publicHeaders } from '../packages/edge-core/index';

test('joins base + path without a double slash (trailing slash on base)', () => {
  assert.strictEqual(
    originTarget('https://x.awsapprunner.com/', '/', ''),
    'https://x.awsapprunner.com/'
  );
  assert.strictEqual(
    originTarget('https://x.awsapprunner.com', '/', ''),
    'https://x.awsapprunner.com/'
  );
});

test('preserves path + query', () => {
  assert.strictEqual(
    originTarget('https://x.com/', '/products/red', '?store=t_acme'),
    'https://x.com/products/red?store=t_acme'
  );
});

test('publicHeaders strips internal x-* but keeps public response headers (M-5)', () => {
  const h = new Headers({
    'content-type': 'text/html',
    'cache-control': 'public, s-maxage=300',
    'content-security-policy': "default-src 'none'",
    'x-surrogate-keys': 't:t_acme t:t_acme:route:/',
    'x-tenant': 't_acme',
    'x-render-count': '5',
    'x-page-type': 'home',
  });
  const out = publicHeaders(h);
  assert.strictEqual(out.get('content-type'), 'text/html');
  assert.strictEqual(out.get('cache-control'), 'public, s-maxage=300');
  assert.match(out.get('content-security-policy') || '', /default-src/);
  assert.strictEqual(out.get('x-surrogate-keys'), null);
  assert.strictEqual(out.get('x-tenant'), null);
  assert.strictEqual(out.get('x-render-count'), null);
  assert.strictEqual(out.get('x-page-type'), null);
});

test('proxyInit: GET forwards no body and injects the trusted tenant/secret', () => {
  const req = new Request('http://edge/', {
    method: 'GET',
    headers: { 'x-ratio-tenant': 't_spoof', 'x-edge-auth': 'spoof' },
  });
  const init = proxyInit(req, 't_real', 'real-secret');
  assert.strictEqual(init.method, 'GET');
  assert.strictEqual(init.body ?? null, null);
  assert.strictEqual(init.duplex, undefined);
  const h = init.headers as Headers;
  assert.strictEqual(h.get('x-ratio-tenant'), 't_real'); // client spoof dropped
  assert.strictEqual(h.get('x-edge-auth'), 'real-secret');
});

test('proxyInit: POST forwards the body + content-type with duplex half', () => {
  const req = new Request('http://edge/cart', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ratio-tenant': 't_spoof' },
    body: JSON.stringify({ sku: 'x' }),
  });
  const init = proxyInit(req, 't_real', 'real-secret');
  assert.strictEqual(init.method, 'POST');
  assert.ok(init.body, 'the request body is forwarded');
  assert.strictEqual(init.duplex, 'half');
  const h = init.headers as Headers;
  assert.strictEqual(h.get('content-type'), 'application/json');
  assert.strictEqual(h.get('x-ratio-tenant'), 't_real'); // not the client-supplied value
});
