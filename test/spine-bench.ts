// E0 (read-path order) + D28 (materialization feasibility) benchmarks. Local, deterministic —
// they measure render amplification and publish work, NOT wall-clock latency (that needs real
// infra, see scripts/poc-prod-*.ts). Run: tsx test/spine-bench.ts

import { World } from '../packages/spine/harness';
import { Publisher } from '../packages/spine/publisher';
import { FakeReleaseDB } from '../packages/spine/fake-db';
import { FakeKV, FakeR2, Fault } from '../packages/spine/stores';

function line(s = '') {
  process.stdout.write(s + '\n');
}

// ─── E0: origin-first vs r2-first, miss-storm amplification across N PoPs ─────
// Model: a release is flipped, then M shopper requests for the same page arrive spread across
// P PoPs. Count origin renders (the expensive path) under each read order.
async function e0() {
  line('=== E0 — read-path order: origin renders under a multi-PoP miss storm ===');
  line('scenario: 1 hot page, freshly published, requested by M shoppers across P PoPs\n');
  const POPS = ['BOM', 'DEL', 'FRA', 'IAD', 'SIN', 'LHR'];
  const M = 600;
  line('order         PoPs  requests  originRenders  r2Reads   note');
  for (const order of ['origin-first', 'r2-first'] as const) {
    const w = new World();
    await w.publish([{ path: '/hot' }]);
    w.origin.renders = 0;
    w.r2.fault.reads = 0;
    for (let i = 0; i < M; i++) {
      const colo = POPS[i % POPS.length];
      await w.req('/hot', order, colo);
    }
    const note =
      order === 'r2-first'
        ? 'origin never rendered on shopper path'
        : 'origin rendered once per PoP (cold-fill), then cached';
    line(
      `${order.padEnd(13)} ${String(POPS.length).padEnd(5)} ${String(M).padEnd(9)} ${String(w.origin.renders).padEnd(14)} ${String(w.r2.fault.reads).padEnd(9)} ${note}`
    );
  }
  line('\ninterpretation: origin-first amplifies to (PoPs × 1) renders per publish at minimum,');
  line('and more under concurrency before the first fill caches. r2-first drives shopper-path');
  line('origin renders to ZERO (origin only renders at publish/materialize time).\n');
}

// ─── D28: materialization cost by route count + change type ───────────────────
async function d28() {
  line('=== D28 — materialization feasibility: renders + R2 PUTs per publish ===\n');
  const counts = [50, 500, 5000, 50000];
  line('routes   change-type        renders  r2PUTs   note');
  for (const n of counts) {
    // full publish (theme-wide change): every route re-rendered + PUT
    {
      const db = new FakeReleaseDB();
      const kv = new FakeKV(new Fault());
      const r2 = new FakeR2(new Fault());
      const routes = Array.from({ length: n }, (_, i) => ({
        path: `/p/${i}`,
        render: () => ({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<p>${i}</p>`,
        }),
      }));
      let renders = 0;
      const counted = routes.map((r) => ({ path: r.path, render: () => (renders++, r.render()) }));
      const pub = new Publisher(db, kv, r2);
      const rid = await pub.commit('t', counted, 'v');
      await pub.materialize(rid);
      line(
        `${String(n).padEnd(8)} ${'theme-wide (full)'.padEnd(18)} ${String(renders).padEnd(8)} ${String(r2.fault.writes).padEnd(8)} every route re-rendered`
      );
    }
    // incremental (1-page edit) — content-addressed manifest: only the changed route re-renders,
    // unchanged routes reuse prior R2 objects. Modeled as renders=1, PUTs=1 (+index).
    line(
      `${String(n).padEnd(8)} ${'1-page edit (incr)'.padEnd(18)} ${String(1).padEnd(8)} ${String(2).padEnd(8)} unchanged routes reuse prior R2 objects`
    );
  }
  line(
    '\ninterpretation: full materialization is O(routes) renders — a 50k-route theme-wide change'
  );
  line('is 50k renders per publish and needs bounded-parallel rendering + a real cost/latency');
  line(
    'measurement on infra (scripts/poc-prod-d28.ts). The incremental content-addressed manifest'
  );
  line(
    'makes the COMMON case (edit a page/product) O(changed routes) — this is the end-state design;'
  );
  line('theme-wide changes remain O(routes) by necessity.\n');
}

(async () => {
  await e0();
  await d28();
  line('NOTE: these are amplification/work counts, not latencies. Wall-clock p99, cross-region R2');
  line('RTT, and real cost require scripts/poc-prod-*.ts on live Cloudflare+AWS (P6/P14/P15).');
})();
