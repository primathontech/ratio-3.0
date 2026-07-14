// M-5: hosts are case-insensitive; onboarding must store them lowercase, or a mixed-case
// host becomes a dead row the (always-lowercase) browser Host header never matches.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-hostnorm-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const ID = 't_hostnorm';
const humans: Verifier = async (t) => (t === 'tok-a' ? { userId: 'user_hostnorm' } : null);
const app = createApp(composeVerifiers(agentVerifier, humans));

async function cleanup() {
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

test('POST /stores stores a mixed-case host lowercased', async () => {
  const res = await app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ id: ID, name: 'HostNorm', host: 'MixedCase.LOCALHOST' }),
    })
  );
  assert.strictEqual(res.status, 201);
  const { rows } = await pool.query<{ host: string }>(
    'SELECT host FROM domains WHERE tenant_id=$1',
    [ID]
  );
  assert.strictEqual(rows[0]?.host, 'mixedcase.localhost');
});
