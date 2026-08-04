// Track 3 — Edge Port. Proves: (1) the D38 lazy+purge algorithm — render-on-first-visit,
// purge-invalidate marks stale not gone, serve-stale-on-error, S3 last-good backstop (written by
// the ORIGIN, D44), fail-closed host resolution carried over from POC-1; (2) generation-ordered
// last-good writes (a delayed old write can never regress or resurrect content); (3) the real
// drivers sign correctly — SigV4 against the AWS-published test vector, EdgeGrid
// deterministically, Fast Purge/EdgeKV/S3 request shapes via injected fetch; (4) EdgeKV item keys
// and cache tags respect Akamai's charset/length limits. Live tests self-skip without creds.
// Run: node --import tsx --test test/edge-port.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeKV, FakeR2 } from '../packages/spine/stores';
import type { KeyDims } from '../packages/spine/canonical-key';
import { keyDims, r2Key } from '../packages/spine/canonical-key';
import { toStored } from '../packages/spine/response';
import { FakeAkamaiCache } from '../packages/edge-port/akamai-cache';
import { handleLazy, LIVE, type LazyEdgeDeps } from '../packages/edge-port/lazy-edge';
import { LastGoodStore } from '../packages/edge-port/last-good';
import { tenantTag, pageTag } from '../packages/edge-port/tags';
import { edgeKvItemKey } from '../packages/edge-port/edgekv-key';
import { signV4, canonicalRequest } from '../packages/edge-port/drivers/sigv4';
import { signEdgeGrid } from '../packages/edge-port/drivers/edgegrid';
import { FastPurgeDriver, type FetchLike } from '../packages/edge-port/drivers/fastpurge';
import { EdgeKVDriver } from '../packages/edge-port/drivers/edgekv';
import { S3Driver } from '../packages/edge-port/drivers/s3';
import { createHmac, createHash } from 'node:crypto';

// ─── lazy-edge world ─────────────────────────────────────────────────────────

// Fake origin that ALSO plays its D44 role: after a successful shared-safe render it queues the
// generation-ordered last-good write (what PageOrigin does in the real pipeline).
class LazyOrigin {
  renders = 0;
  down = false;
  private pages = new Map<string, { body: string; status?: number; cacheable?: boolean }>();
  private revs = new Map<string, number>();
  constructor(private lastGood: LastGoodStore) {}

  set(path: string, page: { body: string; status?: number; cacheable?: boolean }) {
    this.pages.set(path, page);
    this.revs.set(path, (this.revs.get(path) ?? 0) + 1);
  }

  async fetch(dims: KeyDims) {
    if (this.down) throw new Error('origin down');
    this.renders++;
    const p = this.pages.get(dims.path);
    const res = p
      ? {
          status: p.status ?? 200,
          headers: { 'content-type': 'text/html' },
          body: p.body,
          cacheable: p.cacheable ?? true,
        }
      : {
          status: 404,
          headers: { 'content-type': 'text/html' },
          body: 'Not found',
          cacheable: true,
        };
    // D44 write-behind: shared-safe renders and real 404s (tombstones) reach S3, at this path's
    // current generation; non-cacheable per-user-ish responses never do.
    const gen = this.revs.get(dims.path) ?? 0;
    if (res.cacheable || res.status === 404) {
      void this.lastGood.writeIfNewer(r2Key(dims), toStored(res), gen);
    }
    return res;
  }
}

function world() {
  let now = 1_000_000;
  const clock = () => now;
  const kv = new FakeKV();
  const cache = new FakeAkamaiCache(clock);
  const lastGoodR2 = new FakeR2();
  const lastGood = new LastGoodStore(lastGoodR2);
  const origin = new LazyOrigin(lastGood);
  const deps: LazyEdgeDeps = { kv, cache, lastGood, origin, colo: 'BOM' };
  const seed = (host: string, tenantId: string) =>
    kv.put(`host:${host}`, JSON.stringify({ status: 'active', tenantId }));
  const req = (path: string, host = 'acme.example', method = 'GET') => ({
    method,
    url: `https://${host}${path}`,
    host,
  });
  const tick = (ms: number) => (now += ms);
  return { kv, cache, lastGoodR2, lastGood, origin, deps, seed, req, tick };
}

test('lazy: first visit renders + caches; origin write-behind lands in last-good; repeat is a pure HIT', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/', { body: 'home v1' });

  const first = await handleLazy(w.req('/'), w.deps);
  assert.equal(first.served, 'MISS');
  assert.equal(first.body, 'home v1');
  assert.equal(w.origin.renders, 1);

  await w.lastGood.settle(); // write-behind is async — settle before asserting it landed
  const lg = await w.lastGoodR2.get(r2Key(keyDims('t_acme', LIVE, new URL('https://x/'))));
  assert.ok(lg && lg.body === 'home v1', 'S3 last-good holds the rendered page');
  assert.equal(lg!.generation, 1, 'write carries the page generation');

  const second = await handleLazy(w.req('/'), w.deps);
  assert.equal(second.served, 'HIT');
  assert.equal(w.origin.renders, 1, 'repeat visit does zero origin work');
});

test('lazy: purge-invalidate marks stale → next visit revalidates once, then HITs again', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/p', { body: 'v1' });
  await handleLazy(w.req('/p'), w.deps);

  // merchant edits → save DB → purge the page tag (the whole D38 publish flow)
  w.origin.set('/p', { body: 'v2' });
  await w.cache.invalidateByTags([pageTag('t_acme', '/p')]);

  const after = await handleLazy(w.req('/p'), w.deps);
  assert.equal(after.served, 'REVALIDATED');
  assert.equal(after.body, 'v2', 'revalidation picked up the edit');
  assert.equal(w.origin.renders, 2);

  const again = await handleLazy(w.req('/p'), w.deps);
  assert.equal(again.served, 'HIT', 'fresh again after revalidation');
  assert.equal(w.origin.renders, 2);
});

test('lazy: purge + origin down → serve-stale-on-error hands out the old copy (A3 dissolved)', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/p', { body: 'v1' });
  await handleLazy(w.req('/p'), w.deps);

  await w.cache.invalidateByTags([pageTag('t_acme', '/p')]);
  w.origin.down = true;

  const r = await handleLazy(w.req('/p'), w.deps);
  assert.equal(r.served, 'STALE');
  assert.equal(r.body, 'v1', 'the invalidated-but-kept copy serves through the outage');
});

test('lazy: cold PoP + origin down → S3 last-good serves (D35 backstop)', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/p', { body: 'v1' });
  await handleLazy(w.req('/p'), w.deps);
  await w.lastGood.settle();

  // model a DIFFERENT PoP: same KV + S3 + origin, but its own empty cache
  const cold = world();
  cold.deps.kv = w.kv;
  cold.deps.lastGood = w.lastGood;
  cold.deps.origin = w.origin;
  w.origin.down = true;

  const r = await handleLazy(cold.req('/p'), cold.deps);
  assert.equal(r.served, 'STALE-S3');
  assert.equal(r.body, 'v1');
});

test('lazy: never-visited page + origin down → 503 (D39 accepted tradeoff)', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.down = true;
  const r = await handleLazy(w.req('/never-seen'), w.deps);
  assert.equal(r.served, '503');
  assert.equal(r.status, 503);
});

test('lazy: fail-closed host resolution — outage 503, absent/malformed/suspended 404', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  await w.kv.put('host:bad.example', 'not json');
  await w.kv.put('host:off.example', JSON.stringify({ status: 'suspended', tenantId: 't_x' }));

  assert.equal((await handleLazy(w.req('/', 'ghost.example'), w.deps)).served, 'store-not-found');
  assert.equal((await handleLazy(w.req('/', 'bad.example'), w.deps)).served, 'store-not-found');
  assert.equal((await handleLazy(w.req('/', 'off.example'), w.deps)).served, 'store-not-found');

  w.kv.fault.down = true;
  const r = await handleLazy(w.req('/'), w.deps);
  assert.equal(r.served, 'kv-unavailable');
  assert.equal(r.status, 503, 'KV outage is retryable, not a 404');
});

test('lazy: reserved paths + non-GET never touch cache', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  for (const p of ['/cart', '/checkout/pay', '/api/x', '/account', '/preview/1']) {
    const r = await handleLazy(w.req(p), w.deps);
    assert.equal(r.served, 'no-store', p);
  }
  assert.equal((await handleLazy(w.req('/', 'acme.example', 'POST'), w.deps)).served, 'no-store');
  assert.equal(w.origin.renders, 0);
});

test('lazy: tenant-wide purge stales every page of ONE tenant, never neighbours', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  await w.seed('zen.example', 't_zen');
  w.origin.set('/a', { body: 'A' });
  w.origin.set('/b', { body: 'B' });
  await handleLazy(w.req('/a'), w.deps);
  await handleLazy(w.req('/b'), w.deps);
  await handleLazy(w.req('/a', 'zen.example'), w.deps);
  const rendersBefore = w.origin.renders;

  await w.cache.invalidateByTags([tenantTag('t_acme')]); // theme-wide edit for acme

  assert.equal((await handleLazy(w.req('/a'), w.deps)).served, 'REVALIDATED');
  assert.equal((await handleLazy(w.req('/b'), w.deps)).served, 'REVALIDATED');
  assert.equal(
    (await handleLazy(w.req('/a', 'zen.example'), w.deps)).served,
    'HIT',
    'zen untouched'
  );
  assert.equal(w.origin.renders, rendersBefore + 2);
});

test('lazy: non-cacheable response is never cached; a stale copy is dropped on real answer', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/p', { body: 'cacheable v1' });
  await handleLazy(w.req('/p'), w.deps);

  // page becomes per-user → origin stops opting in (B-2)
  w.origin.set('/p', { body: 'personal', cacheable: false });
  await w.cache.invalidateByTags([pageTag('t_acme', '/p')]);
  const r = await handleLazy(w.req('/p'), w.deps);
  assert.equal(r.served, 'REVALIDATED');

  // the EDGE copy must be gone — an origin error now falls through to the S3 backstop, never
  // serves from the (dropped) edge entry. S3 last-good serving the old SHARED shell is by design:
  // last-good is only ever written from cacheable renders, so it can't hold per-user bytes (C2).
  w.origin.down = true;
  await w.lastGood.settle();
  const r2 = await handleLazy(w.req('/p'), w.deps);
  assert.equal(r2.served, 'STALE-S3', 'edge cache dropped it; only the S3 backstop remains');
});

test('lazy: deleted page 404 tombstones S3 last-good — no resurrection during outage', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/gone', { body: 'alive' });
  await handleLazy(w.req('/gone'), w.deps);
  await w.lastGood.settle();

  // page deleted → origin 404s (non-cacheable variant = the harder case) → purge
  w.origin.set('/gone', { body: 'Not found', status: 404, cacheable: false });
  await w.cache.invalidateByTags([pageTag('t_acme', '/gone')]);
  await handleLazy(w.req('/gone'), w.deps);
  await w.lastGood.settle();

  const lg = await w.lastGoodR2.get(r2Key(keyDims('t_acme', LIVE, new URL('https://x/gone'))));
  assert.ok(lg && lg.status === 404, 'last-good now holds the 404 tombstone, not the old page');
});

test('lazy: last-good write failure never fails the response', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/', { body: 'ok' });
  w.lastGoodR2.fault.down = true;
  const r = await handleLazy(w.req('/'), w.deps);
  assert.equal(r.served, 'MISS');
  assert.equal(r.body, 'ok');
  await w.lastGood.settle(); // must not reject
});

test('lazy: TTL expiry degrades to stale (revalidate), past the stale window it is gone', async () => {
  const w = world();
  await w.seed('acme.example', 't_acme');
  w.origin.set('/p', { body: 'v1' });
  await handleLazy(w.req('/p'), w.deps);
  await w.lastGood.settle();

  w.tick(31536000 * 1000 + 1000); // past the shell TTL → stale
  assert.equal((await handleLazy(w.req('/p'), w.deps)).served, 'REVALIDATED');

  w.tick(31536000 * 1000 + 8 * 24 * 3600 * 1000); // past TTL + 7d stale window → evicted
  w.origin.down = true;
  const r = await handleLazy(w.req('/p'), w.deps);
  assert.equal(r.served, 'STALE-S3', 'cache evicted — only the S3 backstop remains');
});

// ─── last-good generations (review blocker #4) ───────────────────────────────

const stored = (body: string, status = 200) =>
  toStored({ status, headers: { 'content-type': 'text/html' }, body });

test('last-good: a delayed OLD write can never overwrite a newer one', async () => {
  const r2 = new FakeR2();
  const lg = new LastGoodStore(r2);
  // v2 (gen 2) lands first; the delayed v1 (gen 1) arrives after — the review-repro scenario
  await lg.writeIfNewer('k', stored('v2'), 2);
  await lg.writeIfNewer('k', stored('v1'), 1);
  await lg.settle();
  assert.equal((await r2.get('k'))!.body, 'v2', 'stale generation was dropped');
});

test('last-good: an old 200 cannot resurrect over a newer 404 tombstone (D41)', async () => {
  const r2 = new FakeR2();
  const lg = new LastGoodStore(r2);
  await lg.writeIfNewer('k', stored('alive'), 1);
  await lg.writeIfNewer('k', stored('Not found', 404), 2); // delete → tombstone
  await lg.writeIfNewer('k', stored('alive'), 1); // delayed re-render of the old page
  await lg.settle();
  const got = await r2.get('k');
  assert.equal(got!.status, 404, 'tombstone survives the delayed old write');
});

test('last-good: same-generation replays are idempotent no-ops', async () => {
  const r2 = new FakeR2();
  const lg = new LastGoodStore(r2);
  await lg.writeIfNewer('k', stored('v1'), 1);
  const writesAfterFirst = r2.fault.writes;
  await lg.writeIfNewer('k', stored('v1-replay'), 1);
  await lg.settle();
  assert.equal(r2.fault.writes, writesAfterFirst, 'gen <= stored gen → no write issued');
  assert.equal((await r2.get('k'))!.body, 'v1');
});

// ─── Akamai limit compliance: EdgeKV item keys + cache tags ──────────────────

test('edgekv-key: output uses ONLY the allowed alphabet and matches base64url exactly', () => {
  const samples = ['host:acme.example', 'host:शॉप.भारत', 'host:a-very.long.sub.domain.example'];
  for (const s of samples) {
    const key = edgeKvItemKey(s);
    assert.match(key, /^[0-9a-zA-Z_-]+$/, `charset for ${s}`);
    assert.equal(key, Buffer.from(s, 'utf8').toString('base64url'), `reference encoding for ${s}`);
    assert.ok(key.length <= 512, 'inside the EdgeKV item-id length limit');
  }
  // injective on distinct inputs (the property a lossy sanitizer would break)
  assert.notEqual(edgeKvItemKey('host:acme.example'), edgeKvItemKey('host:acme_example'));
});

test('tags: fixed-length, safe-charset, ≤128 chars even for hostile paths; distinct + deterministic', () => {
  const evil = '/' + 'x'.repeat(500) + '/*()!\'"; DROP';
  for (const tag of [
    tenantTag('t_acme'),
    pageTag('t_acme', '/p'),
    pageTag('t_acme', evil),
    tenantTag('weird tenant *()'),
  ]) {
    assert.ok(tag.length <= 128, `${tag} exceeds Akamai's 128-char purge limit`);
    assert.match(tag, /^[A-Za-z0-9._-]+$/, `${tag} has chars Akamai tags disallow`);
  }
  assert.equal(pageTag('t_acme', evil), pageTag('t_acme', evil), 'deterministic');
  assert.notEqual(
    pageTag('t_acme', '/a'),
    pageTag('t_acme', '/b'),
    'distinct paths, distinct tags'
  );
  assert.notEqual(pageTag('t_a', '/p'), pageTag('t_b', '/p'), 'distinct tenants, distinct tags');
});

// ─── SigV4 — AWS-published test vector ───────────────────────────────────────
// From AWS "Signature Version 4 signing process" documented example: GET iam ListUsers,
// 20150830T123600Z, us-east-1. Expected values are AWS's, not ours — a real conformance check.

const AWS_VECTOR = {
  creds: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'iam',
  },
  req: {
    method: 'GET',
    host: 'iam.amazonaws.com',
    path: '/',
    query: 'Action=ListUsers&Version=2010-05-08',
    headers: {
      host: 'iam.amazonaws.com',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'x-amz-date': '20150830T123600Z',
    },
    body: '',
  },
  canonicalHash: 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
  signature: '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
};

test('sigv4: canonical request matches the AWS-published hash', () => {
  const { text } = canonicalRequest(AWS_VECTOR.req);
  const hash = createHash('sha256').update(text).digest('hex');
  assert.equal(hash, AWS_VECTOR.canonicalHash);
});

test('sigv4: signature matches the AWS-published vector', () => {
  const auth = signV4(AWS_VECTOR.req, AWS_VECTOR.creds, '20150830T123600Z');
  assert.match(auth, new RegExp(`Signature=${AWS_VECTOR.signature}$`));
  assert.match(
    auth,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request/
  );
  assert.match(auth, /SignedHeaders=content-type;host;x-amz-date/);
});

// ─── EdgeGrid signing ────────────────────────────────────────────────────────

test('edgegrid: deterministic signature — independently recomputed HMAC chain matches', () => {
  const creds = {
    host: 'akab-test.luna.akamaiapis.net',
    clientToken: 'ct',
    clientSecret: 'cs',
    accessToken: 'at',
  };
  const ts = '20260722T12:00:00+0000';
  const body = JSON.stringify({ objects: ['t.acme'] });
  const auth = signEdgeGrid(
    { method: 'POST', path: '/ccu/v3/invalidate/tag/production', body },
    creds,
    { timestamp: ts, nonce: 'nonce-1' }
  );

  // recompute the spec by hand, separately from the implementation
  const contentHash = createHash('sha256').update(body).digest('base64');
  const authNoSig = `EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=${ts};nonce=nonce-1;`;
  const data = [
    'POST',
    'https',
    creds.host,
    '/ccu/v3/invalidate/tag/production',
    '',
    contentHash,
    authNoSig,
  ].join('\t');
  const signingKey = createHmac('sha256', 'cs').update(ts).digest('base64');
  const expected = createHmac('sha256', signingKey).update(data).digest('base64');

  assert.equal(auth, `${authNoSig}signature=${expected}`);
});

// ─── driver request shapes (injected fetch — no network) ─────────────────────

const CREDS = {
  host: 'akab-test.luna.akamaiapis.net',
  clientToken: 'ct',
  clientSecret: 'cs',
  accessToken: 'at',
};

function captureFetch(...responses: { status: number; body?: string }[]) {
  const calls: {
    url: string;
    init: { method: string; headers: Record<string, string>; body?: string };
  }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)] ?? { status: 200 };
    return { status: r.status, text: async () => r.body ?? '{}' };
  };
  return { calls, fn };
}

test('fastpurge: invalidate posts the tag list to CCU v3 and accepts 201', async () => {
  const { calls, fn } = captureFetch({ status: 201 });
  const d = new FastPurgeDriver(CREDS, 'production', fn);
  await d.invalidateByTags(['t.acme', pageTag('t_acme', '/p')]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://${CREDS.host}/ccu/v3/invalidate/tag/production`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body!), {
    objects: ['t.acme', pageTag('t_acme', '/p')],
  });
  assert.match(calls[0].init.headers.authorization, /^EG1-HMAC-SHA256 client_token=ct;/);
});

test('fastpurge: non-201 surfaces as an error — a failed purge must never pass silently', async () => {
  const { fn } = captureFetch({ status: 403, body: 'denied' });
  const d = new FastPurgeDriver(CREDS, 'production', fn);
  await assert.rejects(() => d.invalidateByTags(['t.acme']), /HTTP 403/);
});

test('fastpurge: empty tag list is a no-op (no request)', async () => {
  const { calls, fn } = captureFetch({ status: 201 });
  await new FastPurgeDriver(CREDS, 'production', fn).invalidateByTags([]);
  assert.equal(calls.length, 0);
});

test('edgekv driver: item id is the shared base64url encoding; GET 404 → null; 200 → text', async () => {
  const missing = captureFetch({ status: 404 });
  const kv1 = new EdgeKVDriver(
    CREDS,
    { network: 'production', namespace: 'ratio', group: 'hosts' },
    missing.fn
  );
  assert.equal(await kv1.get('host:ghost.example'), null);

  const found = captureFetch({ status: 200, body: '{"status":"active","tenantId":"t_acme"}' });
  const kv2 = new EdgeKVDriver(
    CREDS,
    { network: 'production', namespace: 'ratio', group: 'hosts' },
    found.fn
  );
  assert.equal(await kv2.get('host:acme.example'), '{"status":"active","tenantId":"t_acme"}');
  const expectedItem = edgeKvItemKey('host:acme.example');
  assert.ok(
    found.calls[0].url.endsWith(
      `/edgekv/v1/networks/production/namespaces/ratio/groups/hosts/items/${expectedItem}`
    ),
    'writes and reads share ONE item-key encoding (worker uses the same fn)'
  );
});

test('edgekv driver: PUT failure throws (a lost host write = fail-closed 404s, must be loud)', async () => {
  const { fn } = captureFetch({ status: 500, body: 'boom' });
  const kv = new EdgeKVDriver(
    CREDS,
    { network: 'production', namespace: 'ratio', group: 'hosts' },
    fn
  );
  await assert.rejects(() => kv.put('host:x', '{}'), /HTTP 500/);
});

test('s3 driver: signed GET/PUT shapes; RFC3986 path encoding; 404 → null', async () => {
  const val = { status: 200, headers: {}, body: 'hi', checksum: 'c' };
  const aws = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
  const loc = { bucket: 'ratio-lastgood', region: 'ap-south-1' };

  const missing = captureFetch({ status: 404 });
  assert.equal(await new S3Driver(aws, loc, missing.fn).get('r2/x'), null);

  const putCap = captureFetch({ status: 200 });
  await new S3Driver(aws, loc, putCap.fn).put("r2/t|live|(x)!'*", val);
  const put = putCap.calls[0];
  assert.equal(put.init.method, 'PUT');
  assert.match(put.url, /^https:\/\/ratio-lastgood\.s3\.ap-south-1\.amazonaws\.com\/r2\//);
  // the SigV4-critical characters !'()* must be percent-encoded (standard encoders leave them)
  assert.match(put.url, /%28x%29%21%27%2A$/);
  assert.match(put.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.equal(
    put.init.headers['x-amz-content-sha256'],
    createHash('sha256').update(JSON.stringify(val)).digest('hex'),
    'payload hash covers the actual body'
  );
});

test('s3 driver: list follows continuation tokens — no silent 1000-object truncation', async () => {
  const aws = { accessKeyId: 'AK', secretAccessKey: 'sk' };
  const loc = { bucket: 'b', region: 'ap-south-1' };
  const page1 =
    '<ListBucketResult><IsTruncated>true</IsTruncated>' +
    '<NextContinuationToken>tok+1=</NextContinuationToken>' +
    '<Contents><Key>r2/a</Key></Contents></ListBucketResult>';
  const page2 =
    '<ListBucketResult><IsTruncated>false</IsTruncated>' +
    '<Contents><Key>r2/b</Key></Contents></ListBucketResult>';
  const cap = captureFetch({ status: 200, body: page1 }, { status: 200, body: page2 });
  const keys = await new S3Driver(aws, loc, cap.fn).list('r2/');
  assert.deepEqual(keys, ['r2/a', 'r2/b']);
  assert.equal(cap.calls.length, 2);
  assert.match(cap.calls[0].url, /\?list-type=2&prefix=r2%2F$/);
  assert.match(
    cap.calls[1].url,
    /\?continuation-token=tok%2B1%3D&list-type=2&prefix=r2%2F$/,
    'second call carries the token, query stays sorted for SigV4'
  );
});

// ─── live tier (self-skipping, same pattern as scripts/poc-prod-infra.ts) ────

test(
  'live: S3 round-trip (skips without AWS creds)',
  { skip: !process.env.S3_BUCKET },
  async () => {
    const { s3FromEnv } = await import('../packages/edge-port/drivers/s3');
    const s3 = s3FromEnv()!;
    const key = `r2/livetest/${Date.now()}`;
    const val = { status: 200, headers: {}, body: 'live', checksum: 'x' };
    await s3.put(key, val);
    assert.deepEqual(await s3.get(key), val);
    await s3.delete(key);
  }
);

test(
  'live: Fast Purge invalidate (skips without Akamai creds)',
  { skip: !process.env.AKAMAI_HOST },
  async () => {
    const { edgeGridFromEnv } = await import('../packages/edge-port/drivers/edgegrid');
    const purge = new FastPurgeDriver(edgeGridFromEnv()!, 'staging');
    await purge.invalidateByTags(['t.livetest']);
  }
);
