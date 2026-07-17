// S4 D-R8 (CF-native durable sink): per-request data point to Workers Analytics Engine — the
// queryable-outside-the-isolate complement to the in-memory createMetrics seam. The sampling key
// (indexes) is the tenant, so per-tenant cardinality is bounded and AE samples the long tail
// (ADR-008 D-R8). Same allowlist discipline as the access log — pathname + tenant + numeric
// outcome only, never the query string. See buildMetricPoint + the metrics middleware in worker.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import app, { buildMetricPoint, type AnalyticsEngineDataset } from '../apps/edge/worker';

test('buildMetricPoint indexes by tenant and records status/ms as doubles', () => {
  const p = buildMetricPoint({
    tenantId: 't_acme',
    path: '/p/42',
    status: 200,
    stale: false,
    ms: 12,
  });
  assert.deepStrictEqual(p.indexes, ['t_acme']); // bounded sampling key
  assert.ok(p.doubles?.includes(200), 'status');
  assert.ok(p.doubles?.includes(12), 'ms');
  assert.ok(p.blobs?.includes('/p/42'), 'pathname');
});

test('a null tenant maps to a stable "_none" bucket; stale is a 1/0 double', () => {
  const p = buildMetricPoint({ tenantId: null, path: '/', status: 503, stale: true, ms: 4 });
  assert.deepStrictEqual(p.indexes, ['_none']);
  assert.ok(p.doubles?.includes(1), 'stale=1');
  assert.ok(p.blobs?.includes('stale'));
});

test('D-R8: one metric point is written per request via the bound dataset, no query leak', async () => {
  const points: unknown[] = [];
  const METRICS: AnalyticsEngineDataset = { writeDataPoint: (p) => points.push(p) };
  await app.fetch(new Request('https://acme.example/health?token=abc'), { METRICS } as never);
  assert.strictEqual(points.length, 1);
  assert.doesNotMatch(
    JSON.stringify(points[0]),
    /token|abc/,
    'query string must not leak into metrics'
  );
});

test('metrics are optional: an unbound dataset does not throw', async () => {
  const res = await app.fetch(new Request('https://acme.example/health'), {} as never);
  assert.strictEqual(res.status, 200);
});
