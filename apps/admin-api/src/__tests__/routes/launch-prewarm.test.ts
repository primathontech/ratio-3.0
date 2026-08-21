// fix/launch-prewarm-503: the FIRST visit to a just-launched store paid the origin's full cold cost
// (loadLiveCompiled fetches the compiled bundle from S3/CDN cold), routinely exceeding the edge's
// 1500ms read budget. A brand-new store has no cached copy to serve stale, so that timeout went
// straight to the branded 503. The launch route now pre-warms the origin right after activation so
// the merchant's first "View store" click renders from a hot compiledCache.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-prewarm-secret';
process.env.PLATFORM_ADMIN_IDS = '';
process.env.ORIGIN_URL = 'http://origin.test';
process.env.EDGE_SECRET = 'test-edge-secret';

import { pool } from '@ratio/data-db';
import type { Verifier } from '../../middleware/auth';

// config.ts reads ORIGIN_URL at module-eval time, and both app.ts and middleware/auth import it. A
// static import is hoisted ahead of the env assignments above and would capture originUrl as
// undefined — so import both AFTER the env is set (import type above is erased, so it's safe static).
const { createApp } = await import('../../app');
const { composeVerifiers, agentVerifier } = await import('../../middleware/auth');

const humans: Verifier = async (t) => (t === 'tok-a' ? { userId: 'user_prewarm' } : null);

async function cleanup(id: string) {
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [id]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [id]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [id]);
}

const IDS = ['t_prewarm_ok', 't_prewarm_fail'];
before(async () => {
  for (const id of IDS) await cleanup(id);
});
after(async () => {
  for (const id of IDS) await cleanup(id);
  await pool.end();
});

function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label)), ms))]);
}

function launch(app: ReturnType<typeof createApp>, id: string, host: string) {
  return app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ id, name: 'Prewarm', host }),
    })
  );
}

test('launch pre-warms the origin for the new tenant after activation', async () => {
  const calls: Array<{ url: string; tenant: string | null; auth: string | null }> = [];
  let warmed!: () => void;
  const warmCalled = new Promise<void>((r) => (warmed = r));
  const warmFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const h = new Headers(init?.headers);
    calls.push({ url, tenant: h.get('x-ratio-tenant'), auth: h.get('x-edge-auth') });
    warmed();
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const app = createApp(composeVerifiers(agentVerifier, humans), { warmFetch });
  const res = await launch(app, 't_prewarm_ok', 'prewarmok.localhost');
  assert.strictEqual(res.status, 201, await res.text());

  await within(warmCalled, 3000, 'prewarm never fired');

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tenant, 't_prewarm_ok'); // warms the just-launched tenant
  assert.strictEqual(calls[0].auth, 'test-edge-secret'); // authenticates like the edge does
  assert.ok(calls[0].url.startsWith('http://origin.test/'), calls[0].url); // hits the origin root
});

test('a pre-warm failure does not fail the launch', async () => {
  let attempted!: () => void;
  const wasAttempted = new Promise<void>((r) => (attempted = r));
  const warmFetch = (async () => {
    attempted();
    throw new Error('origin unreachable');
  }) as typeof fetch;

  const app = createApp(composeVerifiers(agentVerifier, humans), { warmFetch });
  const res = await launch(app, 't_prewarm_fail', 'prewarmfail.localhost');
  assert.strictEqual(res.status, 201, await res.text());
  // the launch still tried to warm — the throw was swallowed, not propagated
  await within(wasAttempted, 3000, 'prewarm never attempted');
});
