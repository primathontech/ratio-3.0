// Tenant hard-delete (ADR-010 D-SEC4): provably complete. Real test DB.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { onboardStore, deleteStore } from '../packages/provisioning/index';
import { app } from '../apps/origin/index';
import { pool } from '../packages/shared/db';

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const ID = 't_del';
const HOST = 'del.localhost';

async function residualCount(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM tenants WHERE id=$1)
          + (SELECT count(*) FROM domains WHERE tenant_id=$1)
          + (SELECT count(*) FROM routes WHERE tenant_id=$1) AS n`,
    [id]
  );
  return Number(rows[0].n);
}

after(async () => {
  await deleteStore(ID);
  await pool.end();
});

test('deleteStore removes tenant + domain + routes, provably (zero residual)', async () => {
  await onboardStore({ id: ID, name: 'Del', host: HOST });
  const proof = await deleteStore(ID);
  assert.strictEqual(proof.deleted, true);
  assert.strictEqual(proof.residual, 0);
  assert.strictEqual(await residualCount(ID), 0);
});

test('after delete the store no longer renders (404)', async () => {
  await onboardStore({ id: ID, name: 'Del', host: HOST });
  await deleteStore(ID);
  const res = await app.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': ID } })
  );
  assert.strictEqual(res.status, 404);
});

test('deleteStore is idempotent (deleting a missing store is a no-op)', async () => {
  const proof = await deleteStore('t_does_not_exist');
  assert.strictEqual(proof.deleted, false);
  assert.strictEqual(proof.residual, 0);
});

test('deleteStore rejects a missing id', async () => {
  await assert.rejects(() => deleteStore());
});
