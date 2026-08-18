// Regression: onboarding a fresh store must not 500 just because the deploy has a Cloudflare
// token but no CF_SAAS_ZONE. cfConfig() (which fails-closed in prod on a missing zone) was called
// unconditionally after the store row committed, so a brand-new *.ratiodev.in onboard — which never
// needs custom-hostname cleanup — threw AFTER the commit: the client got a 500 and the stranded
// domain row then 409'd every retry.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-cfzone-secret';
process.env.PLATFORM_ADMIN_IDS = '';
// Reproduce the deployed admin-api shape: production + a CF token present, but the SaaS zone unset,
// and NOT fully KV-configured (so no real Cloudflare network call happens during onboarding).
process.env.NODE_ENV = 'production';
process.env.CLOUDFLARE_API_TOKEN = 'test-cf-token';
delete process.env.CF_SAAS_ZONE;
delete process.env.CF_SAAS_FALLBACK;
delete process.env.CF_ACCOUNT_ID;
delete process.env.CF_KV_NAMESPACE_ID;

import { createApp } from '../../app';
import { composeVerifiers, agentVerifier, type Verifier } from '../../middleware/auth';
import { pool } from '@ratio/data-db';

const ID = 't_cfzone_repro';
const HOST = 'cfzonerepro.localhost';
const humans: Verifier = async (t) => (t === 'tok-a' ? { userId: 'user_cfzone' } : null);
const app = createApp(composeVerifiers(agentVerifier, humans));

async function cleanup() {
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('POST /stores for a fresh domain succeeds even when CF_SAAS_ZONE is unset', async () => {
  const res = await app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ id: ID, name: 'CfZone Repro', host: HOST }),
    })
  );
  assert.strictEqual(res.status, 201, await res.text());
});
