// The one-gate tests (ADR-001 D-MT3) — real test DB, no mocks.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';

after(() => pool.end());

test('deny-by-default: forTenant without a tenantId throws', () => {
  assert.throws(() => forTenant(undefined as unknown as string));
  assert.throws(() => forTenant(''));
  assert.throws(() => forTenant(123 as unknown as string));
});

test('the gate injects tenant_id: A and B resolve to their own rows only', async () => {
  const acme = await forTenant('t_acme').getTenant();
  const beta = await forTenant('t_beta').getTenant();
  assert.strictEqual(acme!.id, 't_acme');
  assert.strictEqual(beta!.id, 't_beta');
  assert.notStrictEqual(acme!.id, beta!.id);
});

test('a scoped read for an unknown tenant yields nothing (deny-by-default)', async () => {
  assert.strictEqual(await forTenant('t_not_a_tenant').getTenant(), null);
});

test('getTenant returns the scoped tenant only', async () => {
  const acme = await forTenant('t_acme').getTenant();
  assert.strictEqual(acme!.id, 't_acme');
  assert.strictEqual(acme!.name, 'Acme');
});
