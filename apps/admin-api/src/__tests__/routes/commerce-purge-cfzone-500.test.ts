// Regression: saving a store's commerce connection must not 500 just because the deploy has a
// Cloudflare token but no CF_SAAS_ZONE. PUT /stores/:id/commerce runs a best-effort edge purge
// (purgeStoreUrls), which called cfConfig() — and cfConfig() fails closed in prod on a missing SaaS
// zone, throwing BEFORE its own `if (!cfg) return null` guard. So the purge (best-effort by design)
// propagated a 500 and the merchant's catalogue connection never saved.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-commerce-cfzone-secret';
process.env.PLATFORM_ADMIN_IDS = '';
process.env.NODE_ENV = 'production';
process.env.CLOUDFLARE_API_TOKEN = 'test-cf-token';
delete process.env.CF_SAAS_ZONE;
delete process.env.CF_SAAS_FALLBACK;
delete process.env.CF_ACCOUNT_ID;
delete process.env.CF_KV_NAMESPACE_ID;

import { createApp } from '../../app';
import { composeVerifiers, agentVerifier, type Verifier } from '../../middleware/auth';
import { pool } from '@ratio/data-db';

const ID = 't_commerce_cfzone';
const HOST = 'commercecfzone.localhost';
const humans: Verifier = async (t) => (t === 'tok-a' ? { userId: 'user_commerce_cfzone' } : null);
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

test('PUT /stores/:id/commerce succeeds even when CF_SAAS_ZONE is unset', async () => {
  const created = await app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ id: ID, name: 'Commerce CfZone', host: HOST }),
    })
  );
  assert.strictEqual(created.status, 201, await created.text());

  const res = await app.fetch(
    new Request(`http://cp/stores/${ID}/commerce`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ merchantId: '196jdfqy1aot' }),
    })
  );
  const body = await res.text();
  assert.strictEqual(res.status, 200, body);
  const { merchantId } = JSON.parse(body) as { merchantId: string };
  assert.strictEqual(merchantId, '196jdfqy1aot');
});
