// ADR-007 / OFCE-399: agent-scoped tokens. The AI agent drives the SAME control-plane API
// as humans. A token is minted for a principal (the merchant it acts for) + a tenant scope;
// it can only NARROW that principal's membership access, never widen it. authN is the token,
// authZ still flows through the memberships table (deny-by-default). Real test DB; the only
// "mock" is the human verifier standing in for Clerk at the boundary.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-agent-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import {
  mintAgentToken,
  verifyAgentToken,
  agentVerifier,
  composeVerifiers,
  type Verifier,
} from '../services/admin-api/auth';
import { forTenant } from '../packages/repo/index';
import { pool } from '../packages/shared/db';

const ALICE = 'user_alice_agent';
const BOB = 'user_bob_agent';
const ID = 't_agent';
const OTHER = 't_agent_other';

// Human side stands in for Clerk; agent side is the real HMAC verifier under test.
const humanTokens: Record<string, string> = { 'tok-alice': ALICE, 'tok-bob': BOB };
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

async function cleanup() {
  for (const t of [ID, OTHER]) {
    await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [t]);
    await pool.query('DELETE FROM routes WHERE tenant_id=$1', [t]);
    await pool.query('DELETE FROM domains WHERE tenant_id=$1', [t]);
    await pool.query('DELETE FROM tenants WHERE id=$1', [t]);
  }
}
before(async () => {
  await cleanup();
  await call('POST', '/stores', 'tok-alice', { id: ID, name: 'Agent CP', host: 'agent.localhost' });
});
after(async () => {
  await cleanup();
  await pool.end();
});

// --- unit: mint / verify -------------------------------------------------------------

test('mintAgentToken round-trips its claims', () => {
  const exp = sec() + 3600;
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp });
  const claims = verifyAgentToken(tok);
  assert.deepStrictEqual(claims, { sub: ALICE, scope: [ID], exp });
});

test('a tampered token fails verification', () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() + 3600 });
  assert.strictEqual(verifyAgentToken(tok.slice(0, -2) + 'xx'), null);
});

test('a token signed with a different secret fails', () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() + 3600 }, 'other-secret');
  assert.strictEqual(verifyAgentToken(tok), null);
});

test('an expired token fails', () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() - 1 });
  assert.strictEqual(verifyAgentToken(tok), null);
});

test('a non-agent bearer token is ignored by the agent verifier', async () => {
  assert.strictEqual(await agentVerifier('tok-alice'), null);
});

// --- integration: same API, scoped -----------------------------------------------------

test('an agent token scoped to the store drives the same read API as its principal', async () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() + 3600 });
  const r = await call('GET', `/stores/${ID}`, tok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(((await r.json()) as { id: string }).id, ID);
});

test('an agent token can edit content through the same endpoint (onboard/edit surface)', async () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() + 3600 });
  const r = await call('PUT', `/stores/${ID}/page`, tok, {
    path: '/',
    pageConfig: { type: 'root', children: [] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(await forTenant(ID).getRoute('/'));
});

test('an agent token is confined to its scope — a different tenant is 403', async () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [OTHER], exp: sec() + 3600 });
  const r = await call('GET', `/stores/${ID}`, tok);
  assert.strictEqual(r.status, 403);
});

test('scope cannot widen access: an agent for a non-member principal is still denied', async () => {
  // BOB has no membership on ID; even a wildcard-scoped agent for BOB is denied.
  const tok = mintAgentToken({ sub: BOB, scope: ['*'], exp: sec() + 3600 });
  const r = await call('GET', `/stores/${ID}`, tok);
  assert.strictEqual(r.status, 403);
});

test("a wildcard agent for the owner reaches the owner's store", async () => {
  const tok = mintAgentToken({ sub: ALICE, scope: ['*'], exp: sec() + 3600 });
  const r = await call('GET', `/stores/${ID}`, tok);
  assert.strictEqual(r.status, 200);
});

test('an expired agent token is rejected at the API boundary (401)', async () => {
  const tok = mintAgentToken({ sub: ALICE, scope: [ID], exp: sec() - 1 });
  const r = await call('GET', `/stores/${ID}`, tok);
  assert.strictEqual(r.status, 401);
});

test('the owner mints a store-scoped agent token via the API and the agent uses it', async () => {
  const minted = await call('POST', `/stores/${ID}/agent-tokens`, 'tok-alice');
  assert.strictEqual(minted.status, 201);
  const { token, scope } = (await minted.json()) as { token: string; scope: string[] };
  assert.deepStrictEqual(scope, [ID]);
  const r = await call('GET', `/stores/${ID}`, token);
  assert.strictEqual(r.status, 200);
});

test('a non-member cannot mint an agent token for a store (403)', async () => {
  const r = await call('POST', `/stores/${ID}/agent-tokens`, 'tok-bob');
  assert.strictEqual(r.status, 403);
});
