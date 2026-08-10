// The one-gate tests (ADR-001 D-MT3) — real test DB, no mocks. Each test provisions its own
// tenants (no reliance on shared seed rows) and cleans them up after.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';

const A = 't_repo_a';
const B = 't_repo_b';

before(async () => {
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1,'Acme'),($2,'Beta') ON CONFLICT (id) DO NOTHING`,
    [A, B]
  );
});
after(async () => {
  await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)', [A, B]);
  await pool.end();
});

test('deny-by-default: forTenant without a tenantId throws', () => {
  assert.throws(() => forTenant(undefined as unknown as string));
  assert.throws(() => forTenant(''));
  assert.throws(() => forTenant(123 as unknown as string));
});

test('the gate injects tenant_id: A and B resolve to their own rows only', async () => {
  const a = await forTenant(A).getTenant();
  const b = await forTenant(B).getTenant();
  assert.strictEqual(a!.id, A);
  assert.strictEqual(b!.id, B);
  assert.notStrictEqual(a!.id, b!.id);
});

test('a scoped read for an unknown tenant yields nothing (deny-by-default)', async () => {
  assert.strictEqual(await forTenant('t_not_a_tenant').getTenant(), null);
});

test('getTenant returns the scoped tenant only', async () => {
  const a = await forTenant(A).getTenant();
  assert.strictEqual(a!.id, A);
  assert.strictEqual(a!.name, 'Acme');
});
