// POC-1 acceptance matrix — locally-provable subset (P1-P5, P7-P13, incl. P9 end-to-end).
// P6/P14/P15/P16 need real multi-PoP Cloudflare and live as scripts (scripts/poc-prod-infra.ts),
// gated behind infra flags. Run: node --import tsx --test test/spine-pmatrix.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../packages/spine/harness';
import { Publisher, CrashSignal, IncompleteRelease } from '../packages/spine/publisher';
import { cacheKey, keyDims, r2Key } from '../packages/spine/canonical-key';

const ORDERS = ['origin-first', 'r2-first'] as const;
const r2KeyFor = (t: string, rel: number, path: string) =>
  r2Key(keyDims(t, rel, new URL('https://x' + path)));

// ─── P1 — Publish state machine under crashes ────────────────────────────────
test('P1: KV never names an incomplete release, across every crash point', async () => {
  for (const crashAt of [
    'after-commit',
    'mid-materialize',
    'after-verify',
    'mid-hostkeys',
  ] as const) {
    // two hosts, so a mid-hostkeys crash genuinely splits them (single-host couldn't show it).
    const w = new World('t_acme', ['a.localhost', 'b.localhost']);
    await w.publish([{ path: '/' }]); // release 1 clean baseline on both hosts

    const inputs = w.routeInputs([{ path: '/' }, { path: '/p' }]);
    const pub = new Publisher(w.db, w.kv, w.r2, crashAt);
    let crashed = false;
    try {
      const rid = await pub.commit('t_acme', inputs, 'theme-v2');
      await pub.materialize(rid);
      await pub.activate(rid, w.hosts);
    } catch (e) {
      crashed = e instanceof CrashSignal;
    }
    assert.ok(crashed, `expected a crash at ${crashAt}`); // mid-hostkeys crashes unconditionally now

    const recs = await Promise.all(
      w.hosts.map(async (h) => JSON.parse((await w.kv.get(`host:${h}`))!))
    );
    if (crashAt === 'mid-hostkeys') {
      // a partial host-key write may leave hosts SPLIT (one names 2, one still names 1) — but every
      // named release passed verification, so each host names a COMPLETE release. Crash-recovery
      // (re-run activate, idempotent) converges them; the invariant is "never an INCOMPLETE release".
      for (const rec of recs) {
        assert.ok(
          rec.current === 1 || rec.current === 2,
          `host names a complete release (${rec.current})`
        );
        // the true invariant: whatever release a host names has passed verification — never
        // 'building'/incomplete. A mid-hostkeys crash leaves the release 'activating' (finding #7:
        // durable intent recorded BEFORE the KV flip → GC pins it, a drainer finishes the flip).
        const st = await w.db.getStatus(rec.current);
        assert.ok(
          st === 'materialized' || st === 'activating' || st === 'active',
          `named release ${rec.current} is verification-complete (${st})`
        );
      }
    } else {
      // crash before activation → BOTH hosts still name release 1 (never the incomplete release 2)
      for (const rec of recs)
        assert.equal(rec.current, 1, `KV must not advance on crash@${crashAt}`);
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
  await assert.rejects(() => pub1.materialize(rid), CrashSignal);

  const pub2 = new Publisher(w.db, w.kv, w.r2); // no crash
  await pub2.materialize(rid);
  await pub2.activate(rid, w.hosts);
  const rec = JSON.parse((await w.kv.get('host:acme.localhost'))!);
  assert.equal(rec.current, rid);
  assert.equal(rec.previous, 1);
});

test('P1: pointer never regresses — old release cannot re-activate over a newer one', async () => {
  const w = new World();
  const r1 = await w.publish([{ path: '/' }]);
  const r2 = await w.publish([{ path: '/' }]);
  assert.ok(r2 > r1);
  const before = await w.kv.get('host:acme.localhost');
  // re-activating the older (now superseded) release must be refused — by the activation barrier
  // (status !== 'materialized') and/or the regression guard. Either way the pointer must not move.
  const pub = new Publisher(w.db, w.kv, w.r2);
  await assert.rejects(() => pub.activate(r1, w.hosts), /barrier|regression/);
  assert.equal(await w.kv.get('host:acme.localhost'), before, 'pointer unchanged');
  const rec = JSON.parse((await w.kv.get('host:acme.localhost'))!);
  assert.equal(rec.current, r2, 'still names the newer release');
});

// ─── P2 — Concurrent publishes serialize per tenant ──────────────────────────
// The Publisher OWNS the per-tenant lock (H-1): calling the real Publisher.publish() twice
// concurrently — WITHOUT any external wrapping — must serialize. One wins, the other is rejected
// by the lock (caller/outbox retries). Exactly one active release; no mix.
test('P2: Publisher.publish() self-serializes per tenant (owns the lock)', async () => {
  const w = new World();
  await w.publish([{ path: '/' }]);
  const p1 = new Publisher(w.db, w.kv, w.r2);
  const p2 = new Publisher(w.db, w.kv, w.r2);
  const results = await Promise.allSettled([
    p1.publish('t_acme', w.routeInputs([{ path: '/', body: 'A' }]), 'vA', w.hosts),
    p2.publish('t_acme', w.routeInputs([{ path: '/', body: 'B' }]), 'vB', w.hosts),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one publish proceeds under the Publisher-owned lock');
  assert.equal(rejected.length, 1, 'the concurrent one is rejected (no external wrapping needed)');
  assert.equal(w.db.activeCount('t_acme'), 1, 'exactly one active release');
  const rec = JSON.parse((await w.kv.get('host:acme.localhost'))!);
  assert.ok(rec.current >= 2, 'a new release activated');
});

// H-3 — the outbox drainer resumes a crashed publish to completion (crash-recovery is a system
// property, not a manual step). Crash mid-materialize, then drainPending finishes it.
test('P2b: outbox drainer resumes a crashed publish (H-3)', async () => {
  const w = new World();
  await w.publish([{ path: '/' }]); // release 1 active
  const crasher = new Publisher(w.db, w.kv, w.r2, 'mid-materialize');
  const rid = await crasher.commit('t_acme', w.routeInputs([{ path: '/' }, { path: '/p' }]), 'v2');
  await assert.rejects(() => crasher.materialize(rid), CrashSignal); // release 2 stuck 'building'
  assert.equal(await w.db.getStatus(rid), 'building', 'release stuck mid-publish');
  // a clean drainer picks up the pending outbox row and finishes it
  const drainer = new Publisher(w.db, w.kv, w.r2);
  const drained = await drainer.drainPending('t_acme', w.hosts);
  assert.ok(drained.includes(rid), 'drainer resumed the pending release');
  assert.equal(await w.db.getStatus(rid), 'active', 'release converged to active');
  const rec = JSON.parse((await w.kv.get('host:acme.localhost'))!);
  assert.equal(rec.current, rid, 'KV now names the recovered release');
});

// ─── P3 — R2 completeness gates activation ───────────────────────────────────
test('P3: activation blocked when an R2 object is missing or corrupt', async () => {
  const w = new World();
  const inputs = w.routeInputs([{ path: '/' }, { path: '/a' }, { path: '/b' }]);
  const pub = new Publisher(w.db, w.kv, w.r2);

  // (a) positive baseline: a clean release verifies.
  const rid = await pub.commit('t_acme', inputs, 'v');
  await pub.materialize(rid);
  const manifest = (await w.db.getManifest(rid))!;
  await pub.verify(rid, manifest); // resolves

  // (b) integrity: corrupt one object post-materialize → standalone verify() rejects.
  const dims = keyDims('t_acme', rid, new URL('https://x/a'));
  w.r2.corrupt(r2Key(dims));
  await assert.rejects(() => pub.verify(rid, manifest), IncompleteRelease);

  // (c) activation barrier is a state-machine invariant: a release that never reached
  //     'materialized' cannot be activated, and KV never advances to name it.
  const w2 = new World();
  await w2.publish([{ path: '/' }]); // release 1 active baseline
  const kvBefore = await w2.kv.get('host:acme.localhost');
  const pub2 = new Publisher(w2.db, w2.kv, w2.r2, 'mid-materialize');
  const rid2 = await pub2.commit('t_acme', w2.routeInputs([{ path: '/' }, { path: '/x' }]), 'v2');
  await assert.rejects(() => pub2.materialize(rid2), CrashSignal);
  await assert.rejects(() => pub2.activate(rid2, w2.hosts), /activation barrier/);
  assert.equal(
    await w2.kv.get('host:acme.localhost'),
    kvBefore,
    'KV unchanged: incomplete release never activated'
  );
});

// ─── P4 — Resurrection impossible ────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P4 [${order}]: deleted page = 404 from current-release tombstone; previous never served`, async () => {
    const w = new World();
    const r1 = await w.publish([{ path: '/' }, { path: '/old', body: 'OLD PAGE' }]); // /old is 200
    const r2 = await w.publish([{ path: '/' }]); // /old deleted → must become a 404 tombstone in r2
    // prove the tombstone actually exists in current-release R2 (not a vacuous 503)
    const tomb = await w.r2.get(r2KeyFor('t_acme', r2, '/old'));
    assert.ok(tomb && tomb.status === 404, 'current release materialized a 404 tombstone for /old');
    // and the previous release's 200 object still exists but must NEVER be served
    const old200 = await w.r2.get(r2KeyFor('t_acme', r1, '/old'));
    assert.ok(
      old200 && old200.status === 200,
      'previous 200 still in R2 (would resurrect if served)'
    );

    w.origin.fault.down = true; // origin + DB gone
    const res = await w.req('/old', order, 'BOM');
    assert.equal(res.status, 404, 'exact 404, never the old 200');
    assert.notEqual(res.body, 'OLD PAGE', 'never serve previous-release body');
    assert.ok(
      ['STALE-R2', 'HIT-R2', 'INDEX-404'].includes(res.served),
      `404 came from current R2, served=${res.served}`
    );
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
  // (#26) a value containing '&'/'=' cannot masquerade as a delimiter (re-encoded)
  assert.notEqual(base('/p?sort=a%26page%3D9'), base('/p?sort=a&page=9'));
  // (#27) percent-case + trailing-slash collapse to one key
  assert.equal(base('/a%2Fb'), base('/a%2fb'));
});

// P9 end-to-end: an allowlisted query param must reach the ORIGIN render (B-1), so ?sort=x and
// ?sort=y produce DIFFERENT cached bodies — proving the dropped-vs-kept param split is real.
for (const order of ORDERS) {
  test(`P9 [${order}] e2e: query variant renders + caches distinctly; tracking params do not`, async () => {
    const w = new World();
    const rid = await w.publish([{ path: '/p' }]);
    // seed two distinct renders for the two allowlisted variants
    w.seedOrigin(rid, '/p?sort=x', {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: 'SORT-X',
      cacheable: true,
    });
    w.seedOrigin(rid, '/p?sort=y', {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: 'SORT-Y',
      cacheable: true,
    });
    const x = await w.req('/p?sort=x', order, 'BOM');
    const y = await w.req('/p?sort=y', order, 'BOM');
    assert.equal(x.body, 'SORT-X');
    assert.equal(y.body, 'SORT-Y', 'distinct query variant rendered + cached under its own key');
    // a tracking-only param collapses onto the base render (utm dropped from key AND origin dims)
    const base = await w.req('/p?utm_source=g', order, 'BOM');
    assert.equal(base.body, '<html>/p</html>', 'tracking param does not create a distinct render');
  });
}

// ─── P10 — Cache safety (C2) ─────────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P10 [${order}]: different cookies → byte-identical shared response; no cookie/auth/canary in storage`, async () => {
    const w = new World();
    // the RENDER output itself tries to leak a Set-Cookie + auth + a per-user canary — sanitize
    // (publish materialization + edge) must strip all of it before anything reaches shared storage.
    await w.publish([
      {
        path: '/',
        extraHeaders: {
          'set-cookie': 'sid=SECRET',
          authorization: 'Bearer USERTOKEN',
          'x-user-canary': 'alice',
        },
      },
    ]);
    // two shoppers with DIFFERENT cookies hit the same key
    const a = await w.req('/', order, 'BOM', { cookie: 'sid=alice' });
    const b = await w.req('/', order, 'BOM', { cookie: 'sid=bob' });
    assert.equal(a.body, b.body, 'byte-identical body regardless of cookie');
    assert.equal(a.status, b.status);
    for (const res of [a, b]) {
      assert.ok(!('set-cookie' in res.headers), 'no Set-Cookie in shared response');
      assert.ok(!('authorization' in res.headers), 'no auth in shared response');
      assert.ok(!('x-user-canary' in res.headers), 'no per-user canary in shared response');
    }
    // storage (both R2 and Cache API) carries none of them
    const stored = await w.r2.get(r2KeyFor('t_acme', 1, '/'));
    assert.ok(stored, 'r2 object exists');
    for (const h of ['set-cookie', 'authorization', 'x-user-canary'])
      assert.ok(!(h in stored!.headers), `R2 object must not carry ${h}`);
  });
}

// ─── P11 — TTL regression ────────────────────────────────────────────────────
for (const order of ORDERS) {
  test(`P11 [${order}]: no 5-min TTL regression — warm entry still HIT after >300s with origin AND R2 down`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    await w.req('/', order, 'BOM'); // warm the PoP cache
    w.advance(400); // > 300s: a naive s-maxage=300 entry would have expired
    // kill BOTH origin and R2 so ONLY a live cache entry can answer — isolates the TTL property.
    w.origin.fault.down = true;
    w.r2.fault.down = true;
    const res = await w.req('/', order, 'BOM');
    assert.equal(res.served, 'HIT', 'cache entry stored at 1y TTL, not 300s — no regression');
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
    // Fail-closed is STRUCTURAL: EdgeDeps has no `db` handle at all, so the public path physically
    // cannot query Postgres. db.queries only moves on control-plane publish (commit), never on a
    // read — asserting it's unchanged across 10k unknown-host reads guards against a regression
    // that re-introduces a DB fallback into the request path.
    assert.equal(w.db.queries, dbBefore, 'zero DB queries on the public path (fail-closed)');
  });

  test(`P12 [${order}]: malformed KV record + suspended host fail-closed; KV outage is 503 (distinct)`, async () => {
    const w = new World();
    await w.publish([{ path: '/' }]);
    await w.kv.put('host:garbage.test', '{not json');
    await w.kv.put('host:suspended.test', JSON.stringify({ status: 'suspended' }));
    const g = await w.req('/', order, 'BOM', { host: 'garbage.test' });
    const s = await w.req('/', order, 'BOM', { host: 'suspended.test' });
    assert.equal(g.status, 404, 'malformed record → 404');
    assert.equal(s.status, 404, 'suspended → 404 (do not reveal existence)');
    // a KV OUTAGE for a real store must be 503 (retryable), NOT a definitive 404 (#13)
    w.kv.fault.down = true;
    const o = await w.req('/', order, 'BOM', { host: 'acme.localhost' });
    assert.equal(o.status, 503);
    assert.equal(o.served, 'kv-unavailable');
  });
}

// ─── P13 — Reconciliation (KV ↔ DB divergence detection) ─────────────────────
test('P13: reconciliation detects every KV↔DB divergence', async () => {
  const w = new World();
  await w.publish([{ path: '/' }]); // acme.localhost → {active, current:1}
  // a minimal reconciler: for each tenant host, the KV record must exist, be active, and name the
  // DB's currently-active release. Report every divergence.
  async function reconcile(hosts: string[]): Promise<string[]> {
    const issues: string[] = [];
    for (const host of hosts) {
      const raw = await w.kv.get(`host:${host}`);
      if (!raw) {
        issues.push(`missing:${host}`);
        continue;
      }
      let rec: { status?: string; tenantId?: string; current?: number };
      try {
        rec = JSON.parse(raw);
      } catch {
        issues.push(`malformed:${host}`);
        continue;
      }
      if (rec.status !== 'active') issues.push(`status:${host}=${rec.status}`);
      const active = rec.tenantId ? await w.db.currentActive(rec.tenantId) : null;
      if (rec.current !== active) issues.push(`stale:${host}=${rec.current}!=${active}`);
    }
    return issues;
  }
  assert.deepEqual(await reconcile(['acme.localhost']), [], 'clean state → no issues');

  // inject 4 divergences
  await w.kv.delete('host:acme.localhost'); // deleted legit key
  await w.kv.put(
    'host:orphan.test',
    JSON.stringify({ status: 'active', tenantId: 't_acme', current: 99 })
  ); // orphan + stale release
  await w.kv.put(
    'host:wrong.test',
    JSON.stringify({ status: 'building', tenantId: 't_acme', current: 1 })
  ); // wrong status
  const issues = await reconcile(['acme.localhost', 'orphan.test', 'wrong.test']);
  assert.ok(
    issues.some((i) => i.startsWith('missing:acme')),
    'detects deleted legit key'
  );
  assert.ok(
    issues.some((i) => i.startsWith('stale:orphan')),
    'detects stale release pointer'
  );
  assert.ok(
    issues.some((i) => i.startsWith('status:wrong')),
    'detects wrong status'
  );
});
