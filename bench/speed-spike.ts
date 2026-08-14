// OFCE-600 storefront-speed spike. Reproducible, in-process micro-benchmark of the origin's
// bundle-theme render path (cache MISS = every in-process fetch is a full render), the untrusted
// isolate's per-render worker cost, and co-tenant safety (a runaway template must not slow peers).
//
// Real Postgres + MinIO, no mocks. Seeds its OWN self-contained ROOT theme (no shared base) under
// bench_speed_* ids and cleans them up on exit/error, so it never touches the test fixtures.
//
//   Run: DATABASE_URL=postgres://poc:poc@localhost:5433/s2poc_test \
//        BUNDLE_S3_ENDPOINT=http://localhost:9000 BUNDLE_S3_BUCKET=s2poc-test \
//        BUNDLE_S3_KEY=poc BUNDLE_S3_SECRET=poc12345 \
//        node --import tsx --import ./tests/bootstrap.ts bench/speed-spike.ts
//
// Timing granularity: the origin's `timed()`/access-log uses Date.now() (whole ms), so per-phase
// numbers are quantised to 1ms. The bench's own wall-clock (isolate/co-tenant) uses performance.now()
// (sub-ms). StubResolver is a deterministic in-memory stand-in, NOT a real commerce backend — the
// MISS numbers therefore EXCLUDE real network data-fetch latency (see the report caveats).

import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore } from '@ratio/builder-core';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { render } from '@ratio/builder-render';
import { renderUntrusted, RenderTimeout, RenderFailed } from '@ratio/builder-render/isolate';

// Capture the origin's structured logs IN-PROCESS, so every request's `evt:render` JSON line
// (carrying ms/bundle/compose/db_tenant/…) is collected here. setLoggerForTest reassigns the
// origin's live `logger` binding; the request middleware reads it per-request, so calling it at
// module load (after the hoisted `app` import) is in time for the first fetch — same seam the
// render-log test uses. A static `app` import (not dynamic) keeps a single shared log.ts instance
// under the tsx CJS runner, so the reassignment actually reaches the app.
import { app } from '../apps/origin/src/index';
import { setLoggerForTest } from '../apps/origin/src/log';
const logLines: string[] = [];
setLoggerForTest({ write: (line: string) => logLines.push(line) });

const SECRET = resolveEdgeSecret(process.env);
const endpoint = process.env.BUNDLE_S3_ENDPOINT;
const bucket = process.env.BUNDLE_S3_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.BUNDLE_S3_KEY ?? 'poc',
  secretAccessKey: process.env.BUNDLE_S3_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };

if (!endpoint) {
  throw new Error(
    'set BUNDLE_S3_ENDPOINT (MinIO) + a migrated DATABASE_URL — see the header comment'
  );
}

const T = 'bench_speed_t1';
const THEME = 'bench_speed_t1_main';

// A data-bound product-list section: loops the resolver-injected products. This is the untrusted
// merchant Liquid the origin runs in the isolate — reused verbatim for measurements A and B.
const PRODUCT_LIST_LIQUID =
  '<ul class="products">{% for p in products %}<li>{{ p.title | escape }} {{ p.price | money }}</li>{% endfor %}</ul>';

const N = 200;
const WARMUP = 20;

function pctile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}
function stats(sample: number[]) {
  const s = [...sample].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p50: pctile(s, 50),
    p95: pctile(s, 95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');

async function seed() {
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await cleanup();
  await pool.query(
    "INSERT INTO tenants (id, name, status) VALUES ($1, 'Bench Speed Store', 'active')",
    [T]
  );

  // A representative home page: header + hero + a DATA-BOUND product grid + footer. A self-contained
  // ROOT theme (no base) so the shared library fixture is untouched. index.json wires a
  // COLLECTION_BY_HANDLES data source (handle 'summer') into the product-list via dataSourceKey; the
  // origin's StubResolver returns deterministic sample products for it (no COMMERCE_* env configured).
  const store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(T, THEME);
  await store.saveDraft(
    { themeId: THEME },
    {
      'layout/theme.liquid':
        '<!doctype html><html><head><title>Bench</title></head><body>{{ content_for_layout }}</body></html>',
      'sections/header.liquid':
        '<header class="site-header"><nav>{{ shop_name | default: "Bench Store" }}</nav></header>',
      'sections/footer.liquid': '<footer class="site-footer"><p>© Bench Store</p></footer>',
      'sections/hero.liquid':
        '<section class="hero"><h1>{{ heading | escape }}</h1><p>{{ subheading | escape }}</p></section>',
      'sections/product-list.liquid': PRODUCT_LIST_LIQUID,
      'templates/index.json': JSON.stringify({
        dataSources: {
          grid: {
            type: 'COLLECTION_BY_HANDLES',
            params: { handles: ['summer'], productLimit: 12 },
          },
        },
        sections: [
          { type: 'header', data: {} },
          { type: 'hero', data: { heading: 'Summer Sale', subheading: 'Up to 50% off' } },
          { type: 'product-list', dataSourceKey: 'grid', data: {} },
          { type: 'footer', data: {} },
        ],
      }),
    }
  );
  await store.publish({ themeId: THEME }, { compile: (s) => s });
}

async function cleanup() {
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
}

// One full cache-MISS render through the origin. Returns the parsed `evt:render` log line so the
// bench can read the ms/bundle/compose sub-phases the origin recorded for THIS request.
async function fetchHome(): Promise<Record<string, number>> {
  const before = logLines.length;
  const res = await app.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': T } })
  );
  const body = await res.text();
  if (res.headers.get('x-handler') !== 'theme-bundle') {
    throw new Error(
      `expected theme-bundle handler, got ${res.headers.get('x-handler')} / ${res.status}`
    );
  }
  if (!/class="products"/.test(body) || !/Sample product 1/.test(body)) {
    throw new Error('bench store did not render the data-bound product grid with sample data');
  }
  for (let i = logLines.length - 1; i >= before; i--) {
    const rec = JSON.parse(logLines[i]) as Record<string, unknown>;
    if (rec.evt === 'render' && rec.path === '/') return rec as Record<string, number>;
  }
  throw new Error('no evt:render log line captured for the request');
}

async function measureA() {
  for (let i = 0; i < WARMUP; i++) await fetchHome();
  const total: number[] = [];
  const bundle: number[] = [];
  const compose: number[] = [];
  const dbTenant: number[] = [];
  const other: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = await fetchHome();
    const ms = r.ms ?? 0;
    const b = r.bundle ?? 0;
    const c = r.compose ?? 0;
    const d = r.db_tenant ?? 0;
    total.push(ms);
    bundle.push(b);
    compose.push(c);
    dbTenant.push(d);
    other.push(Math.max(0, ms - b - c - d));
  }
  return { total, bundle, compose, dbTenant, other };
}

async function measureB() {
  const products = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i + 1}`,
    title: `Sample product ${i + 1}`,
    price: 49900 + i * 10000,
  }));
  const data = { products };

  // Warm the in-process compile cache + JIT so the raw-engine sample is render-only, not first-parse.
  for (let i = 0; i < WARMUP; i++) await render(PRODUCT_LIST_LIQUID, data, { trusted: false });
  const engine: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await render(PRODUCT_LIST_LIQUID, data, { trusted: false });
    engine.push(performance.now() - t0);
  }

  // Isolate = spawn a fresh worker thread + render inside it, per call (isolate.ts spawns per render).
  for (let i = 0; i < WARMUP; i++) await renderUntrusted(PRODUCT_LIST_LIQUID, data);
  const isolate: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await renderUntrusted(PRODUCT_LIST_LIQUID, data);
    isolate.push(performance.now() - t0);
  }
  return { engine, isolate };
}

async function measureC() {
  const LEGIT = '<ul>{% for p in products %}<li>{{ p.title | escape }}</li>{% endfor %}</ul>';
  const legitData = { products: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] };
  const CONCURRENCY = 20;

  const timeOne = async (fn: () => Promise<unknown>): Promise<number> => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };

  // Baseline: 20 legit isolate renders concurrently, NO runaway in flight.
  const baseline = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => timeOne(() => renderUntrusted(LEGIT, legitData)))
  );

  // With a runaway (near-infinite loop, timeoutMs 500) launched CONCURRENTLY. The runaway must not
  // starve its 20 co-tenant peers — they run in their own worker threads and must complete fast.
  const RUNAWAY = '{% for i in (1..100000000) %}{{ i }}{% endfor %}';
  let runawayMs = NaN;
  let runawayRejected = false;
  let runawayErr = '';
  const runaway = (async () => {
    const t0 = performance.now();
    try {
      await renderUntrusted(RUNAWAY, {}, { timeoutMs: 500 });
    } catch (e) {
      runawayRejected = true;
      runawayErr =
        e instanceof RenderTimeout
          ? 'RenderTimeout'
          : e instanceof RenderFailed
            ? 'RenderFailed'
            : 'other';
    } finally {
      runawayMs = performance.now() - t0;
    }
  })();
  const withRunaway = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => timeOne(() => renderUntrusted(LEGIT, legitData)))
  );
  await runaway;

  return { baseline, withRunaway, runawayMs, runawayRejected, runawayErr };
}

function printRow(label: string, s: ReturnType<typeof stats>) {
  console.log(
    `${label.padEnd(34)} ${f2(s.min).padStart(9)} ${f2(s.p50).padStart(9)} ${f2(s.p95).padStart(9)} ${f2(
      s.max
    ).padStart(9)} ${String(s.n).padStart(5)}`
  );
}

async function main() {
  await seed();

  const a = await measureA();
  const b = await measureB();
  const c = await measureC();

  const sTotal = stats(a.total);
  const sBundle = stats(a.bundle);
  const sCompose = stats(a.compose);
  const sOther = stats(a.other);
  const sDb = stats(a.dbTenant);
  const sEngine = stats(b.engine);
  const sIsolate = stats(b.isolate);
  const sBase = stats(c.baseline);
  const sWith = stats(c.withRunaway);

  console.log('\n=================== OFCE-600 storefront-speed spike ===================');
  console.log(`N=${N} measured, ${WARMUP} warmup discarded. real Postgres :5433 + MinIO :9000.\n`);
  console.log(
    `${'measurement'.padEnd(34)} ${'min'.padStart(9)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)} ${'n'.padStart(5)}   (ms)`
  );
  console.log('-'.repeat(90));
  printRow('A. MISS render total (ms)', sTotal);
  printRow('A.   ├─ bundle (S3 load)', sBundle);
  printRow('A.   ├─ compose (render)', sCompose);
  printRow('A.   ├─ db_tenant', sDb);
  printRow('A.   └─ other (shell/nav/http)', sOther);
  printRow('B. isolate render (worker/call)', sIsolate);
  printRow('B. raw engine render (in-proc)', sEngine);
  printRow('C. legit 20x — NO runaway', sBase);
  printRow('C. legit 20x — WITH runaway', sWith);
  console.log('-'.repeat(90));

  const totMean = sTotal.mean || 1;
  console.log('\nMISS phase split (mean of the captured per-request timing bag):');
  console.log(
    `  compose ${f2(sCompose.mean)}ms (${f2((sCompose.mean / totMean) * 100)}%)  |  ` +
      `bundle ${f2(sBundle.mean)}ms (${f2((sBundle.mean / totMean) * 100)}%)  |  ` +
      `db_tenant ${f2(sDb.mean)}ms (${f2((sDb.mean / totMean) * 100)}%)  |  ` +
      `other ${f2(sOther.mean)}ms (${f2((sOther.mean / totMean) * 100)}%)`
  );
  console.log('  note: Date.now() ms granularity — sub-ms phases quantise to 0/1ms.');

  console.log('\nB. isolate spawn overhead (per-render worker cold-start):');
  console.log(
    `  isolate p50 ${f2(sIsolate.p50)}ms − raw-engine p50 ${f2(sEngine.p50)}ms = ` +
      `~${f2(sIsolate.p50 - sEngine.p50)}ms spawn cost per render.`
  );

  console.log('\nC. co-tenant safety (runaway in flight vs not):');
  console.log(
    `  legit p50/p95 without runaway: ${f2(sBase.p50)}/${f2(sBase.p95)}ms  ` +
      `| with runaway: ${f2(sWith.p50)}/${f2(sWith.p95)}ms`
  );
  console.log(
    `  runaway: rejected=${c.runawayRejected} (${c.runawayErr}) after ${f2(c.runawayMs)}ms ` +
      `(cooperative renderLimit 100ms / wall-clock timeoutMs 500).`
  );
  console.log('======================================================================\n');
}

void (async () => {
  try {
    await main();
  } finally {
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
  }
})();
