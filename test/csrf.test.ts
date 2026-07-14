// I-1: the admin API accepts a __session cookie as auth (browser UI). A browser attaches that
// cookie on cross-site requests, so state-changing requests authenticated by the cookie must
// prove same-origin via the Origin header. Bearer/API clients and safe methods are exempt.
import { test, after } from 'node:test';
import assert from 'node:assert';

process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const v: Verifier = async (t) => (t === 'tok-x' ? { userId: 'user_csrf' } : null);
const ORIGIN = 'https://admin.example';

// createApp captures ADMIN_CORS_ORIGIN at construction; set it just for this app, then restore.
function appWithOrigin() {
  const prev = process.env.ADMIN_CORS_ORIGIN;
  process.env.ADMIN_CORS_ORIGIN = ORIGIN;
  const app = createApp(composeVerifiers(agentVerifier, v), { rateLimit: 1000 });
  if (prev === undefined) delete process.env.ADMIN_CORS_ORIGIN;
  else process.env.ADMIN_CORS_ORIGIN = prev;
  return app;
}

after(() => pool.end());

test('cookie-authenticated mutation with no Origin is blocked (CSRF)', async () => {
  const res = await appWithOrigin().fetch(
    new Request('http://cp/assistant', {
      method: 'POST',
      headers: { cookie: '__session=tok-x' },
    })
  );
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /cross-site/i);
});

test('cookie-authenticated mutation with a foreign Origin is blocked (CSRF)', async () => {
  const res = await appWithOrigin().fetch(
    new Request('http://cp/assistant', {
      method: 'POST',
      headers: { cookie: '__session=tok-x', origin: 'https://evil.example' },
    })
  );
  assert.strictEqual(res.status, 403);
});

test('cookie-authenticated mutation with the trusted Origin passes the CSRF guard', async () => {
  const res = await appWithOrigin().fetch(
    new Request('http://cp/assistant', {
      method: 'POST',
      headers: { cookie: '__session=tok-x', origin: ORIGIN },
    })
  );
  assert.notStrictEqual(res.status, 403); // passes CSRF (then 503 — no ANTHROPIC key configured)
});

test('Bearer-authenticated mutation is exempt (no Origin needed)', async () => {
  const res = await appWithOrigin().fetch(
    new Request('http://cp/assistant', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-x' },
    })
  );
  assert.notStrictEqual(res.status, 403);
});

test('safe (GET) cookie requests are never blocked by the CSRF guard', async () => {
  const res = await appWithOrigin().fetch(
    new Request('http://cp/me', { headers: { cookie: '__session=tok-x' } })
  );
  assert.strictEqual(res.status, 200);
});
