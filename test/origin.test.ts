// Origin contract tests — in-process via app.fetch() (no server, real test DB).
import { test, after } from 'node:test';
import assert from 'node:assert';
import { app, edgeAuthOk } from '../apps/origin/index';
import { pool } from '../packages/shared/db';

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const call = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request('http://origin' + path, { headers }));
const edge = (extra: Record<string, string> = {}) => ({ 'x-edge-auth': SECRET, ...extra });

after(() => pool.end());

test('edgeAuthOk matches only the exact secret, constant-time (L-1)', () => {
  assert.strictEqual(edgeAuthOk('s3cret', 's3cret'), true);
  assert.strictEqual(edgeAuthOk('wrong!', 's3cret'), false);
  assert.strictEqual(edgeAuthOk('s3cre', 's3cret'), false); // length mismatch
  assert.strictEqual(edgeAuthOk(undefined, 's3cret'), false);
});

test('origin is private: no edge auth -> 403', async () => {
  const res = await call('/', { 'x-ratio-tenant': 't_acme' });
  assert.strictEqual(res.status, 403);
});

test('renders a tenant home with tenant + cache + surrogate headers', async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': 't_acme' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-tenant'), 't_acme');
  assert.strictEqual(res.headers.get('x-cache'), 'long');
  assert.match(res.headers.get('x-surrogate-keys') || '', /(^| )t:t_acme( |$)/);
  assert.match(await res.text(), /Acme/);
});

test('reserved path -> no-store system handler', async () => {
  const res = await call('/cart', edge({ 'x-ratio-tenant': 't_acme' }));
  assert.strictEqual(res.headers.get('x-handler'), 'reserved');
  assert.strictEqual(res.headers.get('x-cache'), 'no-store');
});

test('tenant isolation: acme cannot render betas /about route (404)', async () => {
  const res = await call('/about', edge({ 'x-ratio-tenant': 't_acme' }));
  assert.strictEqual(res.status, 404);
});

test('unknown tenant -> 404 no-store', async () => {
  const res = await call('/', edge({ 'x-ratio-tenant': 't_nope' }));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.headers.get('x-cache'), 'no-store');
});

test('a suspended tenant is not served (OFCE-410)', async () => {
  await pool.query(
    `INSERT INTO tenants (id, name, status, theme) VALUES ('t_susp','Susp','suspended','{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET status='suspended'`
  );
  try {
    const res = await call('/', edge({ 'x-ratio-tenant': 't_susp' }));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get('x-cache'), 'no-store');
  } finally {
    await pool.query("DELETE FROM tenants WHERE id='t_susp'");
  }
});
