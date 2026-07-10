// The one-gate tests (ADR-001 D-MT3) — real test DB, no mocks.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { forTenant } from '../src/repo';
import { pool } from '../src/db';

after(() => pool.end());

test('deny-by-default: forTenant without a tenantId throws', () => {
  assert.throws(() => forTenant(undefined as unknown as string));
  assert.throws(() => forTenant(''));
  assert.throws(() => forTenant(123 as unknown as string));
});

test('tenant A cannot read tenant B row (repo is scoped)', async () => {
  const acmeSeesBeta = await forTenant('t_acme').getRoute('/about'); // /about belongs to t_beta
  assert.strictEqual(acmeSeesBeta, null);
});

test('a tenant reads its own route', async () => {
  const betaAbout = await forTenant('t_beta').getRoute('/about');
  assert.ok(betaAbout);
  assert.strictEqual(betaAbout!.tenant_id, 't_beta');
  assert.strictEqual(betaAbout!.page_type, 'page');
});

test('getTenant returns the scoped tenant only', async () => {
  const acme = await forTenant('t_acme').getTenant();
  assert.strictEqual(acme!.id, 't_acme');
  assert.strictEqual(acme!.name, 'Acme');
});
