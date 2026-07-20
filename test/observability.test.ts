// S4 D-R8 (down payment): one structured, tenant-scoped access record per request, emitted to the
// Workers log sink. The record is built from a fixed field allowlist, so header values, cookies,
// secrets, and the query string (which can carry tokens/PII) can NEVER enter it by construction.
// See apps/edge/worker.ts::buildAccessLog + the logging middleware.
import { test } from 'node:test';
import assert from 'node:assert';
import app from '../apps/edge-cloudflare/worker';
import { buildAccessLog } from '../packages/edge-core/index';

test('buildAccessLog keeps only the pathname — never the query string (tokens/PII)', () => {
  const rec = buildAccessLog({
    tenantId: 't_acme',
    method: 'GET',
    url: 'https://acme.example/products/42?token=SECRET&email=a@b.com',
    status: 200,
    stale: false,
    ms: 12.7,
  });
  assert.strictEqual(rec.path, '/products/42');
  assert.strictEqual(rec.tenant, 't_acme');
  assert.strictEqual(rec.status, 200);
  assert.strictEqual(rec.ms, 13); // rounded
  const json = JSON.stringify(rec);
  assert.doesNotMatch(json, /SECRET|token|email|a@b\.com/, 'no query params may leak into the log');
});

test('buildAccessLog records the stale flag and a null tenant', () => {
  const rec = buildAccessLog({
    tenantId: null,
    method: 'GET',
    url: 'https://x.example/',
    status: 503,
    stale: true,
    ms: 3,
  });
  assert.strictEqual(rec.tenant, null);
  assert.strictEqual(rec.stale, true);
  assert.strictEqual(rec.t, 'access');
});

test('D-R8: exactly one access record is emitted per request, and no secrets leak', async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    // /health returns early (no DB), but the logging middleware still wraps it.
    await app.fetch(new Request('https://acme.example/health?token=abc123'), {} as never);
  } finally {
    console.log = orig;
  }
  const access = lines.filter((l) => l.includes('"t":"access"'));
  assert.strictEqual(access.length, 1, 'one access record per request');
  const rec = JSON.parse(access[0]);
  assert.strictEqual(rec.path, '/health');
  assert.strictEqual(rec.status, 200);
  assert.doesNotMatch(access[0], /token|abc123/, 'query string must not leak');
});
