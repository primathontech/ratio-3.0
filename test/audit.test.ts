// ADR-016 Phase 1 (OFCE-401): control-plane audit trail + scope catalog. Every
// authenticated mutation writes exactly one audit row (actor / kind / tenant / action);
// reads and unauthenticated attempts write none. Real test DB; the human verifier stands
// in for Clerk, the agent verifier is the real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-audit-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import {
  mintAgentToken,
  composeVerifiers,
  agentVerifier,
  type Verifier,
} from '../services/admin-api/auth';
import { scopeFor, SCOPES } from '../services/admin-api/scopes';
import { pool } from '../packages/shared/db';

const ALICE = 'user_alice_audit';
const ID = 't_audit';
const humanTokens: Record<string, string> = { 'tok-alice': ALICE };
const humanVerifier: Verifier = async (t) => (humanTokens[t] ? { userId: humanTokens[t] } : null);
const app = createApp(composeVerifiers(agentVerifier, humanVerifier));

const sec = () => Math.floor(Date.now() / 1000);
function call(method: string, path: string, token?: string, body?: unknown) {
  return app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

interface Row {
  actor: string;
  actor_kind: string;
  tenant_id: string | null;
  action: string;
  method: string;
  status: number;
}
async function auditRows(): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    'SELECT actor, actor_kind, tenant_id, action, method, status FROM audit_log WHERE tenant_id=$1 ORDER BY id',
    [ID]
  );
  return rows;
}

async function cleanup() {
  await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('scope catalog maps control-plane routes; non-mapped paths are null', () => {
  assert.strictEqual(scopeFor('POST', '/stores'), SCOPES.STORES_ONBOARD);
  assert.strictEqual(scopeFor('PUT', '/stores/:id/page'), SCOPES.PAGES_WRITE);
  assert.strictEqual(scopeFor('POST', '/stores/:id/domains'), SCOPES.DOMAINS_WRITE);
  assert.strictEqual(scopeFor('GET', '/stores/:id'), SCOPES.STORES_READ);
  assert.strictEqual(scopeFor('GET', '/health'), null);
});

test('creating a store writes a stores:onboard row attributed to the caller (user)', async () => {
  const r = await call('POST', '/stores', 'tok-alice', {
    id: ID,
    name: 'Audit',
    host: 'audit.localhost',
  });
  assert.strictEqual(r.status, 201);
  const row = (await auditRows()).find((x) => x.action === SCOPES.STORES_ONBOARD);
  assert.ok(row, 'onboard is audited');
  assert.strictEqual(row!.actor, ALICE);
  assert.strictEqual(row!.actor_kind, 'user');
  assert.strictEqual(row!.tenant_id, ID);
  assert.strictEqual(row!.status, 201);
});

test('editing a page writes a pages:write row', async () => {
  const r = await call('PUT', `/stores/${ID}/page`, 'tok-alice', {
    path: '/',
    pageConfig: { type: 'root', children: [] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok((await auditRows()).some((x) => x.action === SCOPES.PAGES_WRITE && x.method === 'PUT'));
});

test('reads are NOT audited', async () => {
  const before = (await auditRows()).length;
  await call('GET', `/stores/${ID}`, 'tok-alice');
  await call('GET', `/stores/${ID}/pages`, 'tok-alice');
  assert.strictEqual((await auditRows()).length, before);
});

test('an agent-token mutation is attributed as kind=agent', async () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() + 3600 });
  const r = await call('PUT', `/stores/${ID}/page`, tok, {
    path: '/promo',
    pageConfig: { type: 'root', children: [] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(
    (await auditRows()).some((x) => x.actor_kind === 'agent' && x.action === SCOPES.PAGES_WRITE)
  );
});

test('an unauthenticated (401) attempt writes no audit row', async () => {
  const before = (await auditRows()).length;
  const r = await call('PUT', `/stores/${ID}/page`, undefined, { path: '/x', pageConfig: {} });
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await auditRows()).length, before);
});

test('GET /stores/:id/audit returns recent entries (newest first), membership-gated', async () => {
  const r = await call('GET', `/stores/${ID}/audit`, 'tok-alice');
  assert.strictEqual(r.status, 200);
  const { entries } = (await r.json()) as { entries: { action: string; actorKind: string }[] };
  assert.ok(entries.length > 0);
  assert.ok(entries.some((e) => e.action === SCOPES.PAGES_WRITE));
  // a non-member is denied
  const forbidden = await call('GET', `/stores/${ID}/audit`, undefined);
  assert.strictEqual(forbidden.status, 401);
});
