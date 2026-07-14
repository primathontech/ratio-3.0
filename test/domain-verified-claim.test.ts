// H1 (custom-domain squatting): a domain claim is not authoritative for routing until ownership
// is proven (Cloudflare DV → verified). Until then it's reclaimable, so a squat can't
// permanently block the real owner; and the data plane only routes verified claims.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

import {
  onboardStore,
  addDomain,
  markDomainVerified,
  markDomainConnected,
  ConflictError,
} from '../packages/provisioning/index';
import { pool } from '../packages/shared/db';

const A = 't_dvc_a';
const B = 't_dvc_b';
const CUSTOM = 'dvc-brand.com';
const HIJACK = 'dvc-hijack.com';

async function cleanup() {
  await pool.query('DELETE FROM domains WHERE host = ANY($1)', [[CUSTOM, HIJACK]]);
  for (const id of [A, B]) {
    await pool.query('DELETE FROM memberships WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM routes WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM domains WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
  }
}
before(async () => {
  await cleanup();
  await onboardStore({ id: A, name: 'A', host: 'dvca.localhost', ownerUserId: 'u_dvc_a' });
  await onboardStore({ id: B, name: 'B', host: 'dvcb.localhost', ownerUserId: 'u_dvc_b' });
});
after(async () => {
  await cleanup();
  await pool.end();
});

const verifiedOf = async (host: string) => {
  const { rows } = await pool.query<{ tenant_id: string; verified: boolean }>(
    'SELECT tenant_id, verified FROM domains WHERE host = $1',
    [host]
  );
  return rows[0];
};

test('a platform host is verified on claim; a custom host starts unverified', async () => {
  assert.strictEqual((await verifiedOf('dvca.localhost'))?.verified, true);
  await addDomain(A, CUSTOM);
  assert.strictEqual((await verifiedOf(CUSTOM))?.verified, false);
});

test('an unverified custom claim is reclaimable by another tenant', async () => {
  // A holds the unverified claim from the previous test; B reclaims it, and addDomain reports
  // the prior tenant so the handler can clean up its stale CF hostname (OFCE-422).
  const { reclaimedFrom } = await addDomain(B, CUSTOM);
  assert.strictEqual(reclaimedFrom, A);
  const row = await verifiedOf(CUSTOM);
  assert.strictEqual(row?.tenant_id, B);
  assert.strictEqual(row?.verified, false);
  // A fresh (non-reclaim) claim reports null.
  const fresh = await addDomain(B, 'dvc-fresh.example.com');
  assert.strictEqual(fresh.reclaimedFrom, null);
  await pool.query('DELETE FROM domains WHERE host = $1', ['dvc-fresh.example.com']);
});

test('once verified, the claim is protected from takeover (409)', async () => {
  await markDomainConnected(B, CUSTOM); // B ran its own connect/DV
  await markDomainVerified(B, CUSTOM);
  await assert.rejects(() => addDomain(A, CUSTOM), ConflictError);
  assert.strictEqual((await verifiedOf(CUSTOM))?.tenant_id, B); // still B's
});

test("a reclaimer cannot inherit the prior tenant's DV — verification is connector-bound (R10-H1)", async () => {
  // Victim connects (DV pending) but is not yet verified.
  await addDomain(A, HIJACK);
  await markDomainConnected(A, HIJACK);
  // Attacker reclaims the still-unverified row.
  await addDomain(B, HIJACK);
  assert.strictEqual((await verifiedOf(HIJACK))?.tenant_id, B);
  // Even if Cloudflare now reports the hostname active, the attacker didn't connect it, so a
  // verify attempt is a no-op — the hijack is blocked.
  await markDomainVerified(B, HIJACK);
  assert.strictEqual((await verifiedOf(HIJACK))?.verified, false);
  // The row stays reclaimable, so the real owner can take it back and verify properly.
  await addDomain(A, HIJACK);
  await markDomainConnected(A, HIJACK);
  await markDomainVerified(A, HIJACK);
  const row = await verifiedOf(HIJACK);
  assert.strictEqual(row?.tenant_id, A);
  assert.strictEqual(row?.verified, true);
});

test('the data-plane resolution only returns verified claims (routing gate)', async () => {
  // Reset to an unverified claim and confirm the verified-gated query withholds it.
  await pool.query('UPDATE domains SET verified = false WHERE host = $1', [CUSTOM]);
  const gated = await pool.query(
    'SELECT tenant_id FROM domains WHERE host = $1 AND verified = true',
    [CUSTOM]
  );
  assert.strictEqual(gated.rowCount, 0);
  await markDomainVerified(B, CUSTOM);
  const live = await pool.query(
    'SELECT tenant_id FROM domains WHERE host = $1 AND verified = true',
    [CUSTOM]
  );
  assert.strictEqual(live.rows[0]?.tenant_id, B);
});
