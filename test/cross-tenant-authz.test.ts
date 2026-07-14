// Regression suite for the cross-tenant write vulns found in the security audit:
//   C1 — domain takeover via POST /stores/:id/domains (ON CONFLICT DO UPDATE reassigns host)
//   C2 — store overwrite / host hijack via POST /stores (onboardStore upserts everything)
//   C3 — a store-scoped agent token escaping its scope via POST /stores and /assistant
// All run against the real test DB, in-process. These MUST fail before the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-authz-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import {
  composeVerifiers,
  agentVerifier,
  mintAgentToken,
  type Verifier,
} from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const VICTIM = 'user_victim_authz';
const ATTACKER = 'user_attacker_authz';
const TV = 't_ctv'; // victim store
const TA = 't_cta'; // attacker store
const HV = 'ctv.example.com'; // victim's host
const HA = 'cta.example.com';

const humans: Verifier = async (t) =>
  t === 'tok-victim' ? { userId: VICTIM } : t === 'tok-attacker' ? { userId: ATTACKER } : null;
const app = createApp(composeVerifiers(agentVerifier, humans));

function call(method: string, path: string, token?: string, body?: unknown) {
  return app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function hostTenant(host: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM domains WHERE host=$1',
    [host]
  );
  return rows[0]?.tenant_id ?? null;
}

async function cleanup() {
  for (const id of [TV, TA, 't_ctnew']) {
    await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM routes WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM domains WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM tenants WHERE id=$1', [id]);
  }
}
before(async () => {
  await cleanup();
  // Each merchant creates their own store legitimately.
  assert.strictEqual(
    (await call('POST', '/stores', 'tok-victim', { id: TV, name: 'Victim', host: HV })).status,
    201
  );
  assert.strictEqual(
    (await call('POST', '/stores', 'tok-attacker', { id: TA, name: 'Attacker', host: HA })).status,
    201
  );
  // The victim's custom domain is DV-verified (a real owner). Only verified claims are protected
  // from cross-tenant takeover (H1); unverified claims are intentionally reclaimable.
  await pool.query('UPDATE domains SET verified = true WHERE host IN ($1,$2)', [HV, HA]);
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('C1: a merchant cannot claim a host already owned by another tenant', async () => {
  const res = await call('POST', '/stores/' + TA + '/domains', 'tok-attacker', { host: HV });
  assert.strictEqual(res.status, 409);
  // The victim still owns the host.
  assert.strictEqual(await hostTenant(HV), TV);
});

test('C2 (deface): POST /stores cannot overwrite an existing store owned by someone else', async () => {
  const res = await call('POST', '/stores', 'tok-attacker', {
    id: TV,
    name: 'PWNED',
    host: 'evil.example.com',
  });
  assert.strictEqual(res.status, 409);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id=$1', [TV]);
  assert.strictEqual(rows[0].name, 'Victim');
});

test("C2 (host hijack): onboarding a new store cannot steal another tenant's host", async () => {
  const res = await call('POST', '/stores', 'tok-attacker', {
    id: 't_ctnew',
    name: 'New',
    host: HV,
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(await hostTenant(HV), TV);
});

test('C2 (idempotent): the owner re-onboarding their own store still succeeds', async () => {
  const res = await call('POST', '/stores', 'tok-victim', { id: TV, name: 'Victim', host: HV });
  assert.ok(res.status === 200 || res.status === 201);
});

test('C3: a store-scoped agent token cannot create/overwrite stores via POST /stores', async () => {
  const scoped = mintAgentToken({
    sub: ATTACKER,
    scope: [TA], // "this store only"
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  const res = await call('POST', '/stores', scoped, {
    id: 't_ctnew',
    name: 'X',
    host: 'x2.example.com',
  });
  assert.strictEqual(res.status, 403);
});

test('M4: POST /stores validates required fields with a 400, not a thrown 500', async () => {
  const res = await call('POST', '/stores', 'tok-attacker', { name: 'missing id + host' });
  assert.strictEqual(res.status, 400);
});

test('C3: a store-scoped agent token cannot escalate through /assistant', async () => {
  const scoped = mintAgentToken({
    sub: ATTACKER,
    scope: [TA],
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  const res = await call('POST', '/assistant', scoped, { message: 'do something' });
  assert.strictEqual(res.status, 403);
});
