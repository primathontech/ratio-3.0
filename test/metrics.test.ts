// Observability seam (ADR-008 D-R8): bounded per-tenant cardinality. Deterministic.
import { test } from 'node:test';
import assert from 'node:assert';
import { createMetrics } from '../src/metrics';

test('counts totals across labels', () => {
  const m = createMetrics();
  m.inc('render', { tenant: 't_a' });
  m.inc('render', { tenant: 't_b' });
  m.inc('render', { tenant: 't_a' });
  assert.strictEqual(m.total('render'), 3);
});

test('tracks a per-tenant breakdown', () => {
  const m = createMetrics();
  m.inc('cache_hit', { tenant: 't_a' });
  m.inc('cache_hit', { tenant: 't_a' });
  assert.strictEqual(m.snapshot().cache_hit.t_a, 2);
});

test('bounds tenant-label cardinality (overflow aggregates into _other)', () => {
  const m = createMetrics({ maxTenantsPerMetric: 2 });
  m.inc('render', { tenant: 't1' });
  m.inc('render', { tenant: 't2' });
  m.inc('render', { tenant: 't3' });
  m.inc('render', { tenant: 't4' });
  const snap = m.snapshot().render;
  assert.ok('t1' in snap && 't2' in snap);
  assert.strictEqual(snap._other, 2);
  assert.strictEqual(m.total('render'), 4);
});

test('total of an unknown metric is 0', () => {
  assert.strictEqual(createMetrics().total('nope'), 0);
});
