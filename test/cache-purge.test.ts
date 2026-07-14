// OFCE-411 (audit M-2): content writes must invalidate the edge cache, and storefront
// pages must carry a real, short-TTL Cache-Control so "changes go live" is actually true.
import { test, after } from 'node:test';
import assert from 'node:assert';

process.env.EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';

import { purgeUrls } from '../services/admin-api/domains';
import { app as origin } from '../apps/origin/index';
import { pool } from '../packages/shared/db';

const cfg = { token: 't', zone: 'ratiodev.in', fallback: 'service.ratiodev.in' };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const SECRET = process.env.EDGE_SECRET as string;

after(() => pool.end());

test('purgeUrls POSTs purge_cache with the given files and reports success', async () => {
  const purged: { url: string; body: string }[] = [];
  const fakeCf: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/zones?name=')) return json({ success: true, result: [{ id: 'ZID' }] });
    if (url.includes('/purge_cache')) {
      purged.push({ url, body: String(init?.body) });
      return json({ success: true, result: { id: 'ZID' } });
    }
    return json({ success: false });
  }) as typeof fetch;

  const ok = await purgeUrls(
    cfg,
    ['https://acme.example.com/', 'https://acme.example.com/about'],
    fakeCf
  );
  assert.strictEqual(ok, true);
  assert.strictEqual(purged.length, 1, 'a purge_cache request was made');
  assert.match(purged[0].url, /\/zones\/ZID\/purge_cache$/);
  const sent = JSON.parse(purged[0].body) as { files: string[] };
  assert.deepStrictEqual(sent.files, [
    'https://acme.example.com/',
    'https://acme.example.com/about',
  ]);
});

test('purgeUrls is a no-op (success) when there are no URLs', async () => {
  const boom: typeof fetch = (() => {
    throw new Error('should not be called');
  }) as typeof fetch;
  assert.strictEqual(await purgeUrls(cfg, [], boom), true);
});

test('purgeUrls reports failure when Cloudflare rejects', async () => {
  const fail: typeof fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/zones?name='))
      return json({ success: true, result: [{ id: 'ZID' }] });
    return json({ success: false, errors: [{ message: 'nope' }] });
  }) as typeof fetch;
  assert.strictEqual(await purgeUrls(cfg, ['https://x/'], fail), false);
});

test('storefront cacheable pages carry a short-TTL Cache-Control with stale-while-revalidate', async () => {
  const res = await origin.fetch(
    new Request('http://origin/', {
      headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': 't_acme' },
    })
  );
  assert.strictEqual(res.status, 200);
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /s-maxage=300/);
  assert.match(cc, /stale-while-revalidate/);
});
