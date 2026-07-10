// Origin contract tests — in-process via app.fetch() (no server, real test DB).
// Locks the S2/S1 behaviours of the shared host. New behaviour is added test-first.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/origin');
const { pool } = require('../src/db');

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const call = (path, headers = {}) => app.fetch(new Request('http://origin' + path, { headers }));
const edge = (extra = {}) => ({ 'x-edge-auth': SECRET, ...extra });

after(() => pool.end());

test('origin is private: no edge auth -> 403', async () => {
  const res = await call('/', { 'x-ratio-tenant': 't_acme' });
  assert.strictEqual(res.status, 403);
});

test('renders a tenant home with tenant + cache + surrogate headers', async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': 't_acme' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-tenant'), 't_acme');
  assert.strictEqual(res.headers.get('x-cache'), 'long'); // T0/cacheable
  assert.match(res.headers.get('x-surrogate-keys'), /(^| )t:t_acme( |$)/);
  assert.match(await res.text(), /Acme/);
});

test('reserved path -> no-store system handler', async () => {
  const res = await call('/cart', edge({ 'x-ratio-tenant': 't_acme' }));
  assert.strictEqual(res.headers.get('x-handler'), 'reserved');
  assert.strictEqual(res.headers.get('x-cache'), 'no-store'); // T3
});

test('tenant isolation: acme cannot render betas /about route (404)', async () => {
  const res = await call('/about', edge({ 'x-ratio-tenant': 't_acme' })); // /about is t_beta's
  assert.strictEqual(res.status, 404);
});

test('unknown tenant -> 404 no-store', async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': 't_nope' }));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.headers.get('x-cache'), 'no-store');
});
