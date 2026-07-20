// Regression suite for the High-severity audit findings:
//   H1 — stored XSS on the storefront 404 via unescaped tenant.name
//   H2 — origin trusting a hardcoded default edge secret (must fail closed in prod)
//   H3 — ?store= selector bypassing host->tenant isolation (dev/staging only)
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';

import { app as origin, resolveEdgeSecret } from '../apps/origin/index';
import { storeOverrideAllowed } from '../packages/edge-core/index';
import { pool } from '../packages/shared/db';

const SECRET = process.env.EDGE_SECRET as string;
const TX = 't_sec_xss';

before(async () => {
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [TX]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [TX]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [TX]);
  await pool.query('INSERT INTO tenants (id, name, theme) VALUES ($1,$2,$3)', [
    TX,
    '<script>alert(1)</script>',
    JSON.stringify({ color: '#111' }),
  ]);
});
after(async () => {
  await pool.query('DELETE FROM tenants WHERE id=$1', [TX]);
  await pool.end();
});

test('H1: the storefront 404 escapes a malicious tenant name', async () => {
  const res = await origin.fetch(
    new Request('http://origin/does-not-exist', {
      headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': TX },
    })
  );
  assert.strictEqual(res.status, 404);
  const body = await res.text();
  assert.ok(!body.includes('<script>alert(1)</script>'), 'raw script must not be reflected');
  assert.ok(body.includes('&lt;script&gt;'), 'tenant name must be HTML-escaped');
});

test('H2: resolveEdgeSecret fails closed in production and defaults only in dev', () => {
  assert.throws(() => resolveEdgeSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv));
  assert.strictEqual(
    resolveEdgeSecret({ NODE_ENV: 'production', EDGE_SECRET: 'real' } as NodeJS.ProcessEnv),
    'real'
  );
  assert.strictEqual(resolveEdgeSecret({} as NodeJS.ProcessEnv), 'private-link-secret');
});

test('H3/C-1: ?store= override is allowed only on localhost, never any public host', () => {
  assert.strictEqual(storeOverrideAllowed('shop.ratiodev.in'), false);
  assert.strictEqual(storeOverrideAllowed('acme.com'), false);
  assert.strictEqual(storeOverrideAllowed('brand.example.com:443'), false);
  // workers.dev is publicly reachable in prod (workers_dev=true) — must NOT allow override.
  assert.strictEqual(storeOverrideAllowed('ratio.workers.dev'), false);
  assert.strictEqual(storeOverrideAllowed('localhost:8787'), true);
  assert.strictEqual(storeOverrideAllowed('acme.localhost'), true);
});
