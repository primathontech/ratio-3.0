// Base-theme propagation endpoints (OFCE-633 Phase 2): the platform-admin surface over builder-core's
// planBaseRebase/applyBaseRebase. In-process via app.fetch(), real test DB, injected verifier, in-memory
// ObjectStore (S3 faked — the store logic is unit-tested in builder-core against MinIO). This covers the
// HTTP wrapper: platform-admin authz, the preview/apply shapes, input validation, and the 503 gate.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../../app';
import { composeVerifiers, agentVerifier, mintAgentToken } from '../../../middleware/auth';
import { ThemeStore } from '@ratio/builder-core';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_bp'; // a normal user (not a platform admin)
const SUPER = 'user_super_bp'; // platform admin
process.env.PLATFORM_ADMIN_IDS = SUPER; // read lazily by isPlatformAdmin
process.env.AGENT_TOKEN_SECRET = 'test-bp-secret'; // lets agentVerifier decode minted agent tokens
delete process.env.CLERK_SECRET_KEY; // keep auth on the injected-verifier path (no network)

const TOKENS: Record<string, string> = { 'tok-alice': ALICE, 'tok-super': SUPER };
const human = async (token: string) => (TOKENS[token] ? { userId: TOKENS[token] } : null);
// Compose the agent verifier so a scope-narrowed agent token is DECODED (and thus caught by
// denyNarrowedScope) rather than bouncing as an unknown 401.
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
const appNoStore = createApp(verify, { bundleThemes: null }); // exercises the 503 gate

const alice = { authorization: 'Bearer tok-alice' };
const superadmin = { authorization: 'Bearer tok-super' };

const BASE_TENANT = '_bp_route_lib';
const BASE_THEME = 'bp_route_base';
const STORE_TENANT = 't_bp_route_s1';
const STORE_THEME = 't_bp_route_s1_main';
const identity = (s: Record<string, string>) => s;

const V1 = {
  'layout/theme.liquid': '<!doctype html><html><body>{{ content_for_layout }}</body></html>',
  'sections/hero.liquid': '<h1>base hero v1</h1>',
};
const V2 = {
  'layout/theme.liquid':
    '<!doctype html><html><body>{{ content_for_layout }}{{ footer }}</body></html>',
  'sections/hero.liquid': '<h1>base hero v2</h1>', // CHANGED — the store overrode this → shadowed
};

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

async function cleanup() {
  for (const th of [BASE_THEME, STORE_THEME])
    await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [th]);
  for (const t of [BASE_TENANT, STORE_TENANT])
    await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [t]);
  await pool.query('DELETE FROM theme WHERE id = ANY($1)', [[BASE_THEME, STORE_THEME]]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[BASE_TENANT, STORE_TENANT]]);
}

// Base v1 → a store adopts it and overrides its hero (live) → base v2 published. Now the store is one
// base version behind, with an override that shadows a file the base changed.
async function seed() {
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'BP Route Lib')`, [BASE_TENANT]);
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'BP Route Store')`, [STORE_TENANT]);
  await store.ensureTheme(BASE_TENANT, BASE_THEME, 'Base');
  await store.saveDraft({ themeId: BASE_THEME, tenantId: BASE_TENANT }, V1);
  await store.publish(
    { themeId: BASE_THEME, tenantId: BASE_TENANT },
    { compile: identity, makeLive: false }
  );

  await store.ensureTheme(STORE_TENANT, STORE_THEME, 'Store', { themeId: BASE_THEME, version: 1 });
  await store.saveDraft(
    { themeId: STORE_THEME, tenantId: STORE_TENANT },
    { 'sections/hero.liquid': '<h1>MY hero</h1>' }
  );
  await store.publish({ themeId: STORE_THEME, tenantId: STORE_TENANT }, { compile: identity });

  await store.saveDraft({ themeId: BASE_THEME, tenantId: BASE_TENANT }, V2);
  await store.publish(
    { themeId: BASE_THEME, tenantId: BASE_TENANT },
    { compile: identity, makeLive: false }
  );
}

before(async () => {
  await cleanup();
  objects.clear();
  await seed();
});
after(cleanup);

test('GET /admin/base-theme: 403 for a non-admin, status for a platform admin', async () => {
  const denied = await call(app, 'GET', '/admin/base-theme', alice);
  assert.equal(denied.status, 403);

  const res = await call(app, 'GET', `/admin/base-theme?baseThemeId=${BASE_THEME}`, superadmin);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { latestVersion: number; storesBehind: number };
  assert.equal(body.latestVersion, 2);
  assert.equal(body.storesBehind, 1);
});

test('POST preview: platform admin gets the plan with shadowed files; non-admin 403', async () => {
  assert.equal(
    (await call(app, 'POST', '/admin/base-theme/propagate/preview', alice, {})).status,
    403
  );

  const res = await call(app, 'POST', '/admin/base-theme/propagate/preview', superadmin, {
    baseThemeId: BASE_THEME,
  });
  assert.equal(res.status, 200);
  const plan = (await res.json()) as {
    latestVersion: number;
    targets: {
      themeId: string;
      fromVersion: number;
      toVersion: number;
      isLive: boolean;
      shadowedFiles: string[];
    }[];
  };
  assert.equal(plan.latestVersion, 2);
  const t = plan.targets.find((x) => x.themeId === STORE_THEME);
  assert.ok(t, 'the store is in the plan');
  assert.equal(t!.fromVersion, 1);
  assert.equal(t!.toVersion, 2);
  assert.equal(t!.isLive, true);
  assert.deepEqual(t!.shadowedFiles, ['sections/hero.liquid']);
});

test('POST preview: an unknown baseThemeId is a client error (400), not a 500', async () => {
  const res = await call(app, 'POST', '/admin/base-theme/propagate/preview', superadmin, {
    baseThemeId: 'no_such_base',
  });
  assert.equal(res.status, 400);
});

test('POST apply: rebases the supplied targets and reports per-store; then nothing is behind', async () => {
  const res = await call(app, 'POST', '/admin/base-theme/propagate/apply', superadmin, {
    targets: [{ tenantId: STORE_TENANT, themeId: STORE_THEME }],
  });
  assert.equal(res.status, 200);
  const { outcomes } = (await res.json()) as {
    outcomes: { themeId: string; ok: boolean; version?: number }[];
  };
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, true);
  assert.ok(typeof outcomes[0].version === 'number');

  // The store overrode hero, so its live theme keeps MY hero but the layout advances to base v2.
  const live = await store.loadLiveCompiled(STORE_TENANT);
  assert.equal(live?.['layout/theme.liquid'], V2['layout/theme.liquid']);
  assert.equal(live?.['sections/hero.liquid'], '<h1>MY hero</h1>');

  // Nothing is behind anymore.
  const status = (await (
    await call(app, 'GET', `/admin/base-theme?baseThemeId=${BASE_THEME}`, superadmin)
  ).json()) as { storesBehind: number };
  assert.equal(status.storesBehind, 0);
});

test('POST apply: rejects a missing/empty targets array (400)', async () => {
  assert.equal(
    (await call(app, 'POST', '/admin/base-theme/propagate/apply', superadmin, {})).status,
    400
  );
  assert.equal(
    (await call(app, 'POST', '/admin/base-theme/propagate/apply', superadmin, { targets: [] }))
      .status,
    400
  );
  assert.equal(
    (
      await call(app, 'POST', '/admin/base-theme/propagate/apply', superadmin, {
        targets: [{ tenantId: 'x' }],
      })
    ).status,
    400
  );
});

test('503 when no bundle store is wired', async () => {
  assert.equal((await call(appNoStore, 'GET', '/admin/base-theme', superadmin)).status, 503);
});

test('a scope-narrowed agent token — even for the platform admin — cannot reach these routes', async () => {
  const scoped = mintAgentToken({
    sub: SUPER,
    scope: [STORE_TENANT], // "this one store only" — must not reach a cross-tenant surface
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  const bearer = { authorization: `Bearer ${scoped}` };
  assert.equal((await call(app, 'GET', '/admin/base-theme', bearer)).status, 403);
  assert.equal(
    (await call(app, 'POST', '/admin/base-theme/propagate/preview', bearer, {})).status,
    403
  );
  assert.equal(
    (
      await call(app, 'POST', '/admin/base-theme/propagate/apply', bearer, {
        targets: [{ tenantId: STORE_TENANT, themeId: STORE_THEME }],
      })
    ).status,
    403
  );
});
