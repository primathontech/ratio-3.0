// Base-theme editor endpoints (OFCE-656): a platform admin edits the shared base (`_library` /
// `library-default`) via the same draft/save/publish machinery, publish being makeLive:false. In-process
// via app.fetch(), real test DB, in-memory ObjectStore, injected verifier.
//
// NOTE: we deliberately do NOT test a SUCCESSFUL base publish here — publishing `library-default` cuts a
// version in the shared test DB and would pollute other suites that adopt the base. The publish route's
// makeLive:false + version-cut path is covered by ThemeStore's own tests; here we cover authz, draft
// save/conflict, and the full-document publish guard (which rejects BEFORE cutting a version).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../../app';
import { composeVerifiers, agentVerifier, mintAgentToken } from '../../../middleware/auth';
import { ThemeStore } from '@ratio/builder-core';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_be';
const SUPER = 'user_super_be';
process.env.PLATFORM_ADMIN_IDS = SUPER;
process.env.AGENT_TOKEN_SECRET = 'test-be-secret';
delete process.env.CLERK_SECRET_KEY;

const TOKENS: Record<string, string> = { 'tok-alice': ALICE, 'tok-super': SUPER };
const human = async (token: string) => (TOKENS[token] ? { userId: TOKENS[token] } : null);
const verify = composeVerifiers(agentVerifier, human);

function memStore(): ObjectStore & { clear: () => void } {
  const mem = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => {
      mem.set(k, b as Uint8Array);
      return { etag: 'x' };
    },
    get: async (k) => mem.get(k) ?? null,
    head: async (k) => (mem.has(k) ? { etag: 'x' } : null),
    delete: async (k) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  };
}

const objects = memStore();
const store = new ThemeStore(objects);
const app = createApp(verify, { bundleThemes: store });
const appNoStore = createApp(verify, { bundleThemes: null });

const alice = { authorization: 'Bearer tok-alice' };
const superadmin = { authorization: 'Bearer tok-super' };

const call = (
  a: typeof app,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
) =>
  a.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  );

// Read the base draft the way the editor does (returns the composed base tree + its revision token).
async function getDraft() {
  const res = await call(app, 'GET', '/admin/base-theme/edit/draft', superadmin);
  return (await res.json()) as { files: Record<string, string>; revision: string };
}

before(async () => {
  objects.clear();
});
after(async () => {
  // The GET/seed may have created library-default in a fresh DB; leave it (shared fixture, per the
  // base-library suite's convention). Nothing this file did cut a new library-default version.
  await pool.end();
});

test('GET base draft: 403 for a non-admin, the seeded base for a platform admin', async () => {
  assert.equal((await call(app, 'GET', '/admin/base-theme/edit/draft', alice)).status, 403);

  const res = await call(app, 'GET', '/admin/base-theme/edit/draft', superadmin);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { files: Record<string, string>; revision: string };
  assert.match(
    body.files['layout/theme.liquid'] ?? '',
    /<!doctype/i,
    'the base layout is a full document'
  );
  assert.equal(typeof body.revision, 'string');
});

test('PUT base draft: saves with the current revision, 409 on a stale one', async () => {
  const { files, revision } = await getDraft();
  const edited = { ...files, 'sections/hero.liquid': '<section>EDITED BASE HERO</section>' };

  const ok = await call(app, 'PUT', '/admin/base-theme/edit/draft', superadmin, {
    files: edited,
    revision,
  });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { ok: boolean }).ok, true);

  // The revision moved on; a stale save is refused (409), not last-write-wins.
  const stale = await call(app, 'PUT', '/admin/base-theme/edit/draft', superadmin, {
    files: edited,
    revision,
  });
  assert.equal(stale.status, 409);
});

test('PUT base draft: a missing revision is a 400', async () => {
  const { files } = await getDraft();
  assert.equal(
    (await call(app, 'PUT', '/admin/base-theme/edit/draft', superadmin, { files })).status,
    400
  );
});

test('POST publish: refuses a base whose layout is not a full document (before cutting a version)', async () => {
  const { revision } = await getDraft();
  // A layout that keeps the platform slots (passes save validation) but is NOT a full document.
  const broken = {
    'layout/theme.liquid': '<div>{{ content_for_header }}{{ content_for_layout }}</div>',
  };
  const saved = await call(app, 'PUT', '/admin/base-theme/edit/draft', superadmin, {
    files: broken,
    revision,
  });
  assert.equal(saved.status, 200);

  const res = await call(app, 'POST', '/admin/base-theme/edit/publish', superadmin, {});
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /full HTML document/);

  // Restore a valid base draft so a later test doesn't inherit the broken layout.
  await call(app, 'POST', '/admin/base-theme/edit/reset', superadmin, {});
});

test('POST reset: discards the draft back to the published base', async () => {
  const res = await call(app, 'POST', '/admin/base-theme/edit/reset', superadmin, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; files: Record<string, string> };
  assert.equal(body.ok, true);
  assert.match(
    body.files['layout/theme.liquid'] ?? '',
    /<!doctype/i,
    'back to the full-document base'
  );
});

test('503 when no bundle store is wired', async () => {
  assert.equal(
    (await call(appNoStore, 'GET', '/admin/base-theme/edit/draft', superadmin)).status,
    503
  );
});

test('a scope-narrowed agent token cannot reach the base editor', async () => {
  const scoped = mintAgentToken({
    sub: SUPER,
    scope: ['t_x'],
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  const bearer = { authorization: `Bearer ${scoped}` };
  assert.equal((await call(app, 'GET', '/admin/base-theme/edit/draft', bearer)).status, 403);
  assert.equal((await call(app, 'POST', '/admin/base-theme/edit/publish', bearer, {})).status, 403);
});
