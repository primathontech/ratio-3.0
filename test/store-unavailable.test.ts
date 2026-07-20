// S4 D-R6: when even stale content can't be served, the shopper must get a branded, edge-generated
// "store temporarily unavailable" page — a 503 (not a raw 500), no internal error text, and never
// another tenant's content. app.fetch is driven with a KV stub that throws so a serving failure is
// forced deterministically (no network). See apps/edge/worker.ts::storeUnavailable + app.onError.
import { test } from 'node:test';
import assert from 'node:assert';
import app from '../apps/edge-cloudflare/worker';
import { storeUnavailable } from '../packages/edge-core/index';

test('storeUnavailable is a 503 with Retry-After, no-store, and storefront security headers', async () => {
  const res = storeUnavailable();
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.headers.get('retry-after'), '30');
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(res.headers.get('content-security-policy'), 'must carry the storefront CSP');
  const body = await res.text();
  assert.match(body, /temporarily unavailable/i);
});

test('D-R6: a serving error yields the branded 503, not a raw 500 or leaked error', async () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@db.example/neondb',
    TENANTS: {
      get: async () => {
        throw new Error('kv boom — internal detail that must not leak');
      },
      put: async () => {},
    },
  };
  const res = await app.fetch(new Request('https://acme.example/'), env);
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.headers.get('retry-after'), '30');
  const body = await res.text();
  assert.match(body, /temporarily unavailable/i);
  assert.doesNotMatch(
    body,
    /kv boom|internal detail|stack|Error:/i,
    'must not leak internal error text'
  );
});
