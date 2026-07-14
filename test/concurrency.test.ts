// OFCE-409: page edits use optimistic concurrency. A save that carries a stale version
// (someone — a second tab or the AI assistant — saved in between) is rejected with 409,
// instead of silently clobbering the other write. Real control plane + DB, in-process.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-concurrency-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const OWNER = 'user_conc_owner';
const ID = 't_conc';
const humans: Verifier = async (t) => (t === 'tok-owner' ? { userId: OWNER } : null);
const app = createApp(composeVerifiers(agentVerifier, humans));

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-owner' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const cfg = { sections: [] as unknown[] };

async function cleanup() {
  await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(async () => {
  await cleanup();
  assert.strictEqual(
    (await call('POST', '/stores', { id: ID, name: 'Conc', host: 'conc.localhost' })).status,
    201
  );
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('a page write returns a version, and a stale version is rejected with 409', async () => {
  // Create the page (no version → unconditional create at v1).
  const created = await call('PUT', `/stores/${ID}/page`, { path: '/p', pageConfig: cfg });
  assert.strictEqual(created.status, 200);
  assert.strictEqual((await created.json()).version, 1);

  // GET returns the current version.
  const got = await (await call('GET', `/stores/${ID}/page?path=/p`)).json();
  assert.strictEqual(got.version, 1);

  // A version-matched save succeeds and bumps the version.
  const ok = await call('PUT', `/stores/${ID}/page`, { path: '/p', pageConfig: cfg, version: 1 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).version, 2);

  // A stale save (still thinks it's v1) is rejected — no silent clobber.
  const stale = await call('PUT', `/stores/${ID}/page`, {
    path: '/p',
    pageConfig: cfg,
    version: 1,
  });
  assert.strictEqual(stale.status, 409);

  // The current version is unchanged by the rejected write.
  const still = await (await call('GET', `/stores/${ID}/page?path=/p`)).json();
  assert.strictEqual(still.version, 2);

  // Saving against the current version works again.
  const ok2 = await call('PUT', `/stores/${ID}/page`, { path: '/p', pageConfig: cfg, version: 2 });
  assert.strictEqual(ok2.status, 200);
  assert.strictEqual((await ok2.json()).version, 3);
});
