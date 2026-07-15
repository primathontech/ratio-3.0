// S2/KV step 5: the control plane write-throughs the host->tenant mapping to Workers KV so
// the edge (see lookupTenant) serves from KV without a per-request DB hit. Only VERIFIED
// hosts are published (H1); remove/reclaim/suspend unpublish. fetch is injected so we assert
// the exact CF KV REST call without touching Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  publishTenantMapping,
  unpublishTenantMapping,
  kvConfig,
  type KvConfig,
} from '../services/admin-api/domains';

const cfg: KvConfig = { token: 'tok', accountId: 'acct1', namespaceId: 'ns1' };

function fakeFetch(status = 200) {
  const calls: { url: string; method?: string; body?: unknown; auth?: string | null }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body,
      auth: headers.get('authorization'),
    });
    return new Response(JSON.stringify({ success: true }), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('publishTenantMapping PUTs {"t":tenantId} to the url-encoded host key', async () => {
  const { fn, calls } = fakeFetch();
  await publishTenantMapping(cfg, 'acme.ratiodev.in', 't_acme', fn);
  assert.strictEqual(calls.length, 1);
  assert.match(
    calls[0].url,
    /\/accounts\/acct1\/storage\/kv\/namespaces\/ns1\/values\/host%3Aacme\.ratiodev\.in$/
  );
  assert.strictEqual(calls[0].method, 'PUT');
  assert.strictEqual(calls[0].body, JSON.stringify({ t: 't_acme' }));
  assert.strictEqual(calls[0].auth, 'Bearer tok');
});

test('unpublishTenantMapping DELETEs the host key', async () => {
  const { fn, calls } = fakeFetch();
  await unpublishTenantMapping(cfg, 'acme.ratiodev.in', fn);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /values\/host%3Aacme\.ratiodev\.in$/);
});

test('kvConfig is null unless account + namespace + token are all set (graceful no-op)', () => {
  const saved = {
    a: process.env.CF_ACCOUNT_ID,
    n: process.env.CF_KV_NAMESPACE_ID,
    t: process.env.CLOUDFLARE_API_TOKEN,
  };
  delete process.env.CF_KV_NAMESPACE_ID;
  assert.strictEqual(kvConfig(), null);
  process.env.CF_ACCOUNT_ID = saved.a;
  process.env.CF_KV_NAMESPACE_ID = saved.n;
  process.env.CLOUDFLARE_API_TOKEN = saved.t;
});
