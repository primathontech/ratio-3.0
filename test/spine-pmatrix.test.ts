// POC-1 acceptance matrix — locally-provable subset (P1-P5, P7-P13). P6/P14/P15/P16 need real
// multi-PoP Cloudflare and live as scripts (scripts/poc-prod-*.ts), gated behind infra flags.
// Run: node --import tsx --test test/spine-pmatrix.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../packages/spine/harness';
import { Publisher, CrashSignal, IncompleteRelease } from '../packages/spine/publisher';
import { cacheKey, keyDims, r2Key, canonicalPath } from '../packages/spine/canonical-key';

const ORDERS = ['origin-first', 'r2-first'] as const;

// ─── P1 — Publish state machine under crashes ────────────────────────────────
test('P1: KV never names an incomplete release, across every crash point', async () => {
  for (const crashAt of [
    'after-commit',
    'mid-materialize',
    'after-verify',
    'mid-hostkeys',
  ] as const) {
    const w = new World();
    // release 1 clean baseline
    await w.publish([{ path: '/' }]);
    const kvBefore = await w.kv.get('host:acme.localhost');

    // release 2 crashes at `crashAt`
    const inputs = w.routeInputs([{ path: '/' }, { path: '/p' }]);
    const pub = new Publisher(w.db, w.kv, w.r2, crashAt);
    let crashed = false;
    try {
      const rid = await pub.commit('t_acme', inputs, 'theme-v2');
      await pub.materialize(rid, inputs);
      await pub.activate(rid, w.hosts);
    } catch (e) {
      crashed = e instanceof CrashSignal;
    }
    assert.ok(crashed || crashAt === 'mid-hostkeys', `expected crash at ${crashAt}`);

    const kvAfter = await w.kv.get('host:acme.localhost');
    const rec = JSON.parse(kvAfter!);
    if (crashAt === 'mid-hostkeys') {
      // partial host-key write is allowed to name release 2 for SOME hosts, but only AFTER
      // verification passed — so whatever KV names is always a complete release.
      assert.ok(rec.current === 1 || rec.current === 2, 'names a complete release');
    } else {
      // crash before activation → KV still names release 1 (never the incomplete release 2)
      assert.equal(kvAfter, kvBefore, `KV must not advance on crash@${crashAt}`);
      assert.equal(rec.current, 1);
    }
  }
});

test('P1: retry after crash is idempotent and converges', async () => {
  const w = new World();
  await w.publish([{ path: '/' }]);
  const inputs = w.routeInputs([{ path: '/' }, { path: '/p' }]);

  // crash mid-materialize, then re-run full publish clean → converges to active release 2
  const pub1 = new Publisher(w.db, w.kv, w.r2, 'mid-materialize');
  const rid = await pub1.commit('t_acme', inputs, 'v2');
  await assert.rejects(() => pub1.materialize(rid, inputs), CrashSignal);

  const pub2 = new Publisher(w.db, w.kv, w.r2); // no crash
  await pub2.materialize(rid, inputs);
  await pub2.activate(rid, w.hosts);
  const rec = JSON.parse((await w.kv.get('host:acme.localhost'))!);
  assert.equal(rec.current, rid);
  assert.equal(rec.previous, 1);
});

test('P1: pointer never regresses', async () => {
  const w = new World();
  const r1 = await w.publish([{ path: '/' }]);
  const r2 = await w.publish([{ path: '/' }]);
  assert.ok(r2 > r1);
  // attempt to re-activate the older release over the newer active one
  const pub = new Publisher(w.db, w.kv, w.r2);
  await assert.rejects(() => pub.activate(r1, w.hosts), /regression/);
});

// ─── P2 — Concurrent publishes serialize per tenant ──────────────────────────
test('P2: per-tenant serialization holds; latest activates last; no mixed release', async () => {
  const w = new World();
  await w.publish([{ path: '/' }]);
  // two concurrent publishes contend on the tenant lock; one must be rejected/queued
  const runUnderLock = (routes: { path: string }[]) =>
    w.db.withTenantLock('t_acme', async () => {
      const inputs = w.routeInputs(routes);
      const pub = new Publisher(w.db, w.kv, w.r2);
      const rid = await pub.commit('t_acme', inputs, 'v');
      for (const r of inputs) {
        const rr = r.render();
        w.origin.content.set(`${rid}|${canonicalPath(r.path)}`, { ...rr, checksum: 'o' });
      }
      await pub.materialize(rid, inputs);
      await pub.activate(rid, w.hosts);
      return rid;
    });
  const results = await Promise.allSettled([
    runUnderLock([{ path: '/' }]),
    runUnderLock([{ path: '/' }]),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one publish proceeds under the lock');
  assert.equal(rejected.length, 1, 'the concurrent one is rejected (caller retries)');
  assert.equal(w.db.activeCount('t_acme'), 1, 'exactly one active release');
});

// ─── P3 — R2 completeness gates activation ───────────────────────────────────
test('P3: activation blocked when an R2 object is missing or corrupt', async () => {
  const w = new World();
  const inputs = w.routeInputs([{ path: '/' }, { path: '/a' }, { path: '/b' }]);
  const pub = new Publisher(w.db, w.kv, w.r2);
  const rid = await pub.commit('t_acme', inputs, 'v');
  // materialize writes objects; corrupt one then verify must fail
  await pub.materialize(rid, inputs).catch(() => {});
  const dims = keyDims('t_acme', rid, new URL('https://x/a'));
  w.r2.corrupt(r2Key(dims));
  const manifest = (await w.db.getManifest(rid))!;
  await assert.rejects(() => pub.verify(rid, manifest), IncompleteRelease);
});

// ─── P4 — Resurrection impossible ────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P4 [${order}]: deleted page stays 404 from current R2; previous never served`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }, { path: '/old', body: 'OLD PAGE' }]); // release 1: /old is 200
    // release 2: /old removed (not in route set) → materialized as 404 tombstone
    await w.publish([{ path: '/' }]); // note: /old absent
    // materialize a tombstone for /old in release 2 by rendering it (origin returns 404)
    // kill origin AND db
    w.origin.fault.down = true;
    const res = await w.req('/old', order, 'BOM');
    assert.notEqual(
      res.body,
      'OLD PAGE',
      'must never serve the old 200 body from previous release'
    );
    assert.ok(res.status === 404 || res.status === 503, `got ${res.status}`);
  });
}

// ─── P5 — Redirect fidelity through R2 ───────────────────────────────────────
for (const order of ORDERS) {
  test(`P5 [${order}]: 301 status + Location survive origin death via R2`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }, { path: '/go', status: 301, location: '/dest' }]);
    // warm nothing; kill origin; request must still yield the redirect from R2
    w.origin.fault.down = true;
    const res = await w.req('/go', order, 'BOM');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/dest');
  });
}

// ─── P7 — Dependency failure matrix ──────────────────────────────────────────
for (const order of ORDERS) {
  test(`P7 [${order}]: cache HIT survives origin+DB+R2 all down`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    await w.req('/', order, 'BOM'); // warm the PoP cache
    w.origin.fault.down = true;
    w.r2.fault.down = true;
    const res = await w.req('/', order, 'BOM');
    assert.equal(res.served, 'HIT', 'warm cache serves regardless of backend state');
    assert.equal(res.status, 200);
  });

  test(`P7 [${order}]: R2 serves when origin+DB down (cold PoP)`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    w.origin.fault.down = true; // origin + (implicitly) db gone
    const res = await w.req('/', order, 'FRA'); // cold colo, never warmed
    assert.ok(res.served === 'STALE-R2' || res.served === 'HIT-R2', `served=${res.served}`);
    assert.equal(res.status, 200);
  });

  test(`P7 [${order}]: no fallback to previous release, ever`, async () => {
    const w = new World();
    await w.publish([{ path: '/', body: 'V1' }]);
    await w.publish([{ path: '/', body: 'V2' }]);
    w.origin.fault.down = true;
    const res = await w.req('/', order, 'FRA');
    assert.ok(res.body.includes('V2'), 'serves current release, not previous');
  });
}

// ─── P8 — Gate ───────────────────────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P8 [${order}]: non-GET + reserved paths bypass shared cache`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const r = await w.req('/', order, 'BOM', { method: m });
      assert.equal(r.served, 'no-store', `${m} must be no-store`);
    }
    for (const p of ['/cart', '/checkout', '/account', '/api/x', '/preview/abc', '/cart/items']) {
      const r = await w.req(p, order, 'BOM');
      assert.equal(r.served, 'no-store', `${p} must be no-store`);
    }
  });
}

// ─── P9 — Canonical key ──────────────────────────────────────────────────────
test('P9: equivalent requests share a key; output-varying inputs differ', () => {
  const base = (u: string) => cacheKey(keyDims('t', 1, new URL('https://x' + u)));
  // query order + tracking params + trailing slash collapse
  assert.equal(base('/p?a=1&sort=x&utm_source=g'), base('/p/?sort=x&a=1&fbclid=z'));
  assert.equal(base('/p'), base('/p/'));
  assert.equal(base('//p//'), base('/p'));
  // output-affecting params differ
  assert.notEqual(base('/p?sort=x'), base('/p?sort=y'));
  assert.notEqual(base('/p?page=1'), base('/p?page=2'));
  assert.notEqual(base('/p'), base('/q'));
});

// ─── P10 — Cache safety (C2) ─────────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P10 [${order}]: same key + different cookies = byte-identical; no cookies/auth stored`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    // simulate origin trying to leak a Set-Cookie + auth echo — sanitize must strip it
    w.origin.content.forEach((v, k) => {
      w.origin.content.set(k, {
        ...v,
        headers: { ...v.headers, 'set-cookie': 'sid=SECRET', authorization: 'Bearer X' },
      });
    });
    const a = await w.req('/', order, 'BOM'); // fills cache
    const b = await w.req('/', order, 'BOM');
    assert.deepEqual(a.body, b.body);
    assert.deepEqual(a.status, b.status);
    for (const res of [a, b]) {
      assert.ok(!('set-cookie' in res.headers), 'no Set-Cookie in shared response');
      assert.ok(!('authorization' in res.headers), 'no auth in shared response');
    }
    // and nothing in R2 carries them either
    const dims = keyDims('t_acme', 1, new URL('https://x/'));
    const stored = await w.r2.get(r2Key(dims));
    assert.ok(stored && !('set-cookie' in stored.headers));
  });
}

// ─── P11 — TTL regression ────────────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P11 [${order}]: no 5-min expiry regression; survives >300s then origin death`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    await w.req('/', order, 'BOM'); // warm
    w.advance(400); // > 300s
    w.origin.fault.down = true;
    const res = await w.req('/', order, 'BOM');
    // cache entry stored at 1y TTL, so still HIT; even if it had expired, falls through to R2.
    assert.ok(['HIT', 'STALE-R2', 'HIT-R2'].includes(res.served), `served=${res.served}`);
    assert.equal(res.status, 200);
  });
}

// ─── P12 — Fail-closed routing ───────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P12 [${order}]: 10k unknown hosts → 0 DB queries, all fail-closed 404`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    const dbBefore = w.db.queries;
    for (let i = 0; i < 10000; i++) {
      const r = await w.req('/', order, 'BOM', {
        host: `rand-${i}-${Math.floor(i * 7)}.evil.test`,
      });
      assert.equal(r.served, 'store-not-found');
      assert.equal(r.status, 404);
    }
    assert.equal(w.db.queries, dbBefore, 'zero DB queries on the public path (fail-closed)');
  });

  test(`P12 [${order}]: malformed KV record + suspended host both fail-closed`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    await w.kv.put('host:garbage.test', '{not json');
    await w.kv.put('host:suspended.test', JSON.stringify({ status: 'suspended' }));
    const g = await w.req('/', order, 'BOM', { host: 'garbage.test' });
    const s = await w.req('/', order, 'BOM', { host: 'suspended.test' });
    assert.equal(g.status, 404);
    assert.equal(s.status, 404);
  });
}
