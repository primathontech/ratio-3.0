// M-4: requireRole('owner') gates destructive/privileged verbs (hard-delete, token-mint,
// domain writes). A non-owner member (e.g. a future 'editor') can read + edit pages but not
// delete the store, mint agent tokens, or change domains. Real control plane + DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-role-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import {
  composeVerifiers,
  agentVerifier,
  mintAgentToken,
  type Verifier,
} from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const OWNER = 'user_role_owner';
const EDITOR = 'user_role_editor';
const ID = 't_role';
const humans: Verifier = async (t) =>
  t === 'tok-owner' ? { userId: OWNER } : t === 'tok-editor' ? { userId: EDITOR } : null;
const app = createApp(composeVerifiers(agentVerifier, humans));

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

async function cleanup() {
  await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(async () => {
  await cleanup();
  // Owner creates the store (→ owner membership), then a non-owner 'editor' is added.
  assert.strictEqual(
    (await call('POST', '/stores', 'tok-owner', { id: ID, name: 'Role', host: 'role.localhost' }))
      .status,
    201
  );
  await pool.query(
    "INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1,$2,'editor')",
    [EDITOR, ID]
  );
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('an editor can read and edit pages (any member)', async () => {
  assert.strictEqual((await call('GET', `/stores/${ID}`, 'tok-editor')).status, 200);
  const put = await call('PUT', `/stores/${ID}/page`, 'tok-editor', {
    path: '/p',
    pageConfig: { sections: [] },
  });
  assert.strictEqual(put.status, 200);
});

test('an editor cannot hard-delete the store (owner-only)', async () => {
  assert.strictEqual((await call('DELETE', `/stores/${ID}`, 'tok-editor')).status, 403);
});

test('an editor cannot mint an agent token (owner-only)', async () => {
  assert.strictEqual((await call('POST', `/stores/${ID}/agent-tokens`, 'tok-editor')).status, 403);
});

test('an editor cannot connect or remove a domain (owner-only)', async () => {
  assert.strictEqual(
    (await call('POST', `/stores/${ID}/domains`, 'tok-editor', { host: 'x.example.com' })).status,
    403
  );
  assert.strictEqual(
    (await call('DELETE', `/stores/${ID}/domains`, 'tok-editor', { host: 'role.localhost' }))
      .status,
    403
  );
});

test('the owner retains all privileged actions', async () => {
  assert.strictEqual((await call('POST', `/stores/${ID}/agent-tokens`, 'tok-owner')).status, 201);
});

test('an agent token cannot mint another agent token (M5 — no privilege persistence)', async () => {
  // A token whose principal is the owner passes requireRole('owner'), but minting from it would
  // let a leaked token renew itself forever. Only human sessions (no scope) may mint.
  const agentTok = mintAgentToken({
    sub: OWNER,
    scope: [ID],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const res = await call('POST', `/stores/${ID}/agent-tokens`, agentTok);
  assert.strictEqual(res.status, 403);
});
