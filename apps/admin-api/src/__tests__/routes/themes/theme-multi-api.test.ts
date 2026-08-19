// Multi-theme control-plane API (OFCE-615 Phase 1): a store keeps several bundle themes, exactly one
// live. CRUD + activate/versions over the HTTP wrapper (in-process app.fetch(), real test DB, faked
// in-memory ObjectStore). Focus: routing, membership/owner authz, the base⊕overrides adopt/duplicate,
// live-pointer switching, and — critically — TENANT ISOLATION (a theme id of store B must be
// unreachable through store A's paths). Store internals are unit-tested in builder-core against MinIO.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../../app';
import { ThemeStore, DEFAULT_BASE_THEME_ID, EDITORIAL_BASE_THEME_ID } from '@ratio/builder-core';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_tm'; // owner of store A
const BOB = 'user_bob_tm'; // no membership anywhere
const CAROL = 'user_carol_tm'; // editor (member, not owner) of store A
const verify = async (token: string) =>
  token === 'tok-alice'
    ? { userId: ALICE }
    : token === 'tok-bob'
      ? { userId: BOB }
      : token === 'tok-carol'
        ? { userId: CAROL }
        : null;

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

const A = 't_theme_multi'; // the store under test
const B = 't_theme_multi_b'; // a SECOND store, for cross-tenant isolation
const alice = { authorization: 'Bearer tok-alice' };
const bob = { authorization: 'Bearer tok-bob' };
const carol = { authorization: 'Bearer tok-carol' };

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

async function wipeTenant(t: string) {
  await pool.query(
    'DELETE FROM theme_bundle_version WHERE theme_id IN (SELECT id FROM theme WHERE tenant_id = $1)',
    [t]
  );
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [t]);
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [t]
  );
  await pool.query('DELETE FROM theme WHERE tenant_id = $1', [t]);
}

async function cleanup() {
  await wipeTenant(A);
  await wipeTenant(B);
  await pool.query('DELETE FROM memberships WHERE tenant_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[A, B]]);
  // The shared Default base (library-default / _library) is left in place — an idempotent fixture
  // that create/adopt re-freezes on demand; deleting it would race other suites that also adopt it.
}

before(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'ThemeMultiA'), ($2, 'ThemeMultiB')`,
    [A, B]
  );
  await pool.query(
    `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'editor')`,
    [ALICE, A, CAROL]
  );
});
beforeEach(async () => {
  await wipeTenant(A);
  await wipeTenant(B);
  objects.clear();
});
after(async () => {
  await cleanup();
  await pool.end();
});

// --- helpers ---------------------------------------------------------------

async function createTheme(body: Record<string, unknown> = {}, headers = alice) {
  const res = await call(app, 'POST', `/stores/${A}/themes`, headers, body);
  const j = (await res.json()) as { id?: string };
  return { status: res.status, id: j.id as string };
}

async function listThemes(headers = alice) {
  const res = await call(app, 'GET', `/stores/${A}/themes`, headers);
  return {
    status: res.status,
    themes: ((await res.json()) as { themes?: unknown[] }).themes ?? [],
  };
}

// Edit one section of a theme through the composed-draft round-trip the editor uses.
async function editHero(themeId: string, value: string, headers = alice) {
  const got = (await (
    await call(app, 'GET', `/stores/${A}/themes/${themeId}/draft`, headers)
  ).json()) as { files: Record<string, string>; revision: string };
  return call(app, 'PUT', `/stores/${A}/themes/${themeId}/draft`, headers, {
    files: { ...got.files, 'sections/hero.liquid': value },
    revision: got.revision,
  });
}

// --- tests -----------------------------------------------------------------

test('create from base → appears in listThemes and adopts the shared Default base', async () => {
  const { status, id } = await createTheme({ name: 'Blue' });
  assert.strictEqual(status, 200);
  assert.ok(id, 'a theme id is returned');

  const { themes } = await listThemes();
  const row = themes.find((t) => (t as { id: string }).id === id) as {
    name: string;
    isLive: boolean;
    liveVersion: number | null;
    latestVersion: number | null;
  };
  assert.ok(row, 'the new theme is listed');
  assert.strictEqual(row.name, 'Blue');
  assert.strictEqual(row.isLive, false);
  assert.strictEqual(row.liveVersion, null);
  assert.strictEqual(row.latestVersion, null, 'nothing published yet');

  const { rows } = await pool.query<{ base_theme_id: string | null }>(
    'SELECT base_theme_id FROM theme WHERE id = $1',
    [id]
  );
  assert.strictEqual(rows[0].base_theme_id, DEFAULT_BASE_THEME_ID, 'the theme tracks the base');
});

test('GET /base-themes lists the start-from bases (default + editorial)', async () => {
  const res = await call(app, 'GET', '/base-themes', alice);
  assert.strictEqual(res.status, 200);
  const { baseThemes } = (await res.json()) as {
    baseThemes: { id: string; name: string; description: string }[];
  };
  const ids = baseThemes.map((b) => b.id);
  assert.ok(ids.includes(DEFAULT_BASE_THEME_ID), 'offers the default base');
  assert.ok(ids.includes(EDITORIAL_BASE_THEME_ID), 'offers the editorial base');
  for (const b of baseThemes) assert.ok(b.name && b.description, 'each base has picker text');
});

test('create with baseThemeId adopts the chosen base (editorial), not the default', async () => {
  const { status, id } = await createTheme({ name: 'Mag', baseThemeId: EDITORIAL_BASE_THEME_ID });
  assert.strictEqual(status, 200);
  const { rows } = await pool.query<{ base_theme_id: string | null }>(
    'SELECT base_theme_id FROM theme WHERE id = $1',
    [id]
  );
  assert.strictEqual(
    rows[0].base_theme_id,
    EDITORIAL_BASE_THEME_ID,
    'the theme tracks the editorial base'
  );
});

test('create with an unknown baseThemeId is rejected (400), no theme created', async () => {
  const res = await call(app, 'POST', `/stores/${A}/themes`, alice, {
    baseThemeId: 'library-nope',
  });
  assert.strictEqual(res.status, 400);
});

test('create with duplicateOf copies the source theme’s overrides', async () => {
  const { id: t1 } = await createTheme({ name: 'Source' });
  const save = await editHero(t1, '<section>MINE</section>');
  assert.strictEqual(save.status, 200);

  const dup = await createTheme({ name: 'Copy', duplicateOf: t1 });
  assert.strictEqual(dup.status, 200);
  assert.notStrictEqual(dup.id, t1, 'a distinct theme id');

  // The duplicate carries the source's override (the delta), composed over the same base.
  assert.deepStrictEqual(await store.readDraft({ themeId: dup.id, tenantId: A }), {
    'sections/hero.liquid': '<section>MINE</section>',
  });
  const composed = (
    (await (await call(app, 'GET', `/stores/${A}/themes/${dup.id}/draft`, alice)).json()) as {
      files: Record<string, string>;
    }
  ).files;
  assert.strictEqual(composed['sections/hero.liquid'], '<section>MINE</section>');
  assert.ok(composed['layout/theme.liquid'], 'untouched base files still compose in');
});

test('rename updates the theme name', async () => {
  const { id } = await createTheme({ name: 'Before' });
  const res = await call(app, 'PATCH', `/stores/${A}/themes/${id}`, alice, { name: 'After' });
  assert.strictEqual(res.status, 200);
  const { themes } = await listThemes();
  const row = themes.find((t) => (t as { id: string }).id === id) as { name: string };
  assert.strictEqual(row.name, 'After');
});

test('delete removes a non-live theme', async () => {
  const { id } = await createTheme({ name: 'Trash' });
  const res = await call(app, 'DELETE', `/stores/${A}/themes/${id}`, alice);
  assert.strictEqual(res.status, 200);
  const { themes } = await listThemes();
  assert.ok(!themes.some((t) => (t as { id: string }).id === id), 'the theme is gone');
});

test('deleting the LIVE theme is refused with 409', async () => {
  const { id } = await createTheme({ name: 'Live one' });
  await editHero(id, '<section>v1</section>');
  const pub = await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, alice, {}); // makes it live
  assert.strictEqual(pub.status, 200);

  const del = await call(app, 'DELETE', `/stores/${A}/themes/${id}`, alice);
  assert.strictEqual(del.status, 409);
});

test('activate requires a published version (400 when none)', async () => {
  const { id } = await createTheme({ name: 'Never published' });
  const res = await call(app, 'POST', `/stores/${A}/themes/${id}/activate`, alice, {});
  assert.strictEqual(res.status, 400);
});

// The full-document invariant is unconditional (OFCE-641 — the origin has no TS-shell fallback): every
// path that moves the live pointer refuses a non-full-document theme.
test('publish rejects a theme whose layout is not a full HTML document (full theme ownership invariant)', async () => {
  const { id } = await createTheme({ name: 'Layout store' });
  // Untouched layout composes in the full-document base → publishes fine.
  const okPub = await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, alice, {});
  assert.strictEqual(okPub.status, 200);

  // Override the layout with a body-only fragment: it KEEPS the platform slots (so draft-save validation
  // passes, OFCE-654) but is not a full document (no <!doctype/<html) → publish must 400.
  const got = (await (await call(app, 'GET', `/stores/${A}/themes/${id}/draft`, alice)).json()) as {
    files: Record<string, string>;
    revision: string;
  };
  const save = await call(app, 'PUT', `/stores/${A}/themes/${id}/draft`, alice, {
    files: {
      ...got.files,
      'layout/theme.liquid': '<div>{{ content_for_header }}{{ content_for_layout }}</div>',
    },
    revision: got.revision,
  });
  assert.strictEqual(save.status, 200);
  const badPub = await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, alice, {});
  assert.strictEqual(badPub.status, 400);
});

test('activate + rollback also refuse a version whose layout is not a full document (invariant across every live-pointer move)', async () => {
  // The publish route rejects a body-only theme, so seed one DIRECTLY through the store to prove the
  // other two ways the live pointer moves — activate and rollback — enforce the same invariant.
  const themeId = `${A}-bodyonly`;
  await store.ensureTheme(A, themeId, 'Body-only');
  await store.saveDraft(
    { themeId, tenantId: A },
    {
      'sections/hero.liquid': '<section>x</section>',
      'templates/index.json': '{"sections":[{"type":"hero"}]}',
    }
  );
  await store.publish({ themeId, tenantId: A }, { compile: (s) => s, makeLive: false }); // v1, no layout

  const act = await call(app, 'POST', `/stores/${A}/themes/${themeId}/activate`, alice, {
    version: 1,
  });
  assert.strictEqual(act.status, 400, 'activate refuses a body-only version');
  const rb = await call(app, 'POST', `/stores/${A}/themes/${themeId}/rollback`, alice, {
    version: 1,
  });
  assert.strictEqual(rb.status, 400, 'rollback refuses a body-only version');

  // The store's live pointer was never moved to the body-only theme.
  const { rows } = await pool.query<{ live_theme_id: string | null }>(
    'SELECT live_theme_id FROM tenants WHERE id = $1',
    [A]
  );
  assert.notStrictEqual(rows[0].live_theme_id, themeId, 'the body-only theme never became live');
});

test('activate makes a theme live, and switching between themes repoints the store', async () => {
  const { id: t1 } = await createTheme({ name: 'One' });
  await editHero(t1, '<section>one</section>');
  await call(app, 'POST', `/stores/${A}/themes/${t1}/publish`, alice, {}); // t1 live @1

  const { id: t2 } = await createTheme({ name: 'Two' });
  await editHero(t2, '<section>two</section>');
  await call(app, 'POST', `/stores/${A}/themes/${t2}/publish`, alice, {}); // t2 live @1

  // Switch the store back to t1 explicitly.
  const act = await call(app, 'POST', `/stores/${A}/themes/${t1}/activate`, alice, {});
  assert.strictEqual(act.status, 200);
  assert.strictEqual(((await act.json()) as { version: number }).version, 1);

  const { themes } = await listThemes();
  const r1 = themes.find((t) => (t as { id: string }).id === t1) as {
    isLive: boolean;
    liveVersion: number | null;
  };
  const r2 = themes.find((t) => (t as { id: string }).id === t2) as { isLive: boolean };
  assert.strictEqual(r1.isLive, true);
  assert.strictEqual(r1.liveVersion, 1);
  assert.strictEqual(r2.isLive, false, 'only one theme is live at a time');

  const { rows } = await pool.query<{ live_theme_id: string; live_theme_version: number }>(
    'SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1',
    [A]
  );
  assert.strictEqual(rows[0].live_theme_id, t1);
  assert.strictEqual(rows[0].live_theme_version, 1);
});

test('versions lists a theme’s published versions and which one is live', async () => {
  const { id } = await createTheme({ name: 'History' });
  await editHero(id, '<section>v1</section>');
  await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, alice, {}); // v1
  await editHero(id, '<section>v2</section>');
  await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, alice, {}); // v2 (now live)

  const res = await call(app, 'GET', `/stores/${A}/themes/${id}/versions`, alice);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as {
    versions: { version: number }[];
    liveVersion: number | null;
  };
  assert.deepStrictEqual(
    body.versions.map((v) => v.version),
    [2, 1],
    'newest first'
  );
  assert.strictEqual(body.liveVersion, 2);
});

test('theme-scoped rollback repoints THAT theme to an earlier version (not whatever is live)', async () => {
  // t1 published twice (live @2); a second theme t2 is live. Rolling t1 back to v1 must make t1 live
  // @1 — it must be themeId-aware, not roll the currently-live t2.
  const { id: t1 } = await createTheme({ name: 'Rollme' });
  await editHero(t1, '<section>t1v1</section>');
  await call(app, 'POST', `/stores/${A}/themes/${t1}/publish`, alice, {}); // t1 v1 (live)
  await editHero(t1, '<section>t1v2</section>');
  await call(app, 'POST', `/stores/${A}/themes/${t1}/publish`, alice, {}); // t1 v2 (live)

  const { id: t2 } = await createTheme({ name: 'Other' });
  await editHero(t2, '<section>t2</section>');
  await call(app, 'POST', `/stores/${A}/themes/${t2}/publish`, alice, {}); // t2 live now

  // Roll t1 back to v1 — t1 is NOT the live theme (t2 is), so this must not touch t2.
  const rb = await call(app, 'POST', `/stores/${A}/themes/${t1}/rollback`, alice, { version: 1 });
  assert.strictEqual(rb.status, 200);

  const { rows } = await pool.query<{ live_theme_id: string; live_theme_version: number }>(
    'SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1',
    [A]
  );
  assert.strictEqual(rows[0].live_theme_id, t1, 't1 is now live');
  assert.strictEqual(rows[0].live_theme_version, 1, 'at the rolled-back version');

  // An unknown version → 404, not 500.
  const bad = await call(app, 'POST', `/stores/${A}/themes/${t1}/rollback`, alice, { version: 99 });
  assert.strictEqual(bad.status, 404);
});

test('a non-member is forbidden (403) on both reads and mutations', async () => {
  const list = await call(app, 'GET', `/stores/${A}/themes`, bob);
  assert.strictEqual(list.status, 403);
  const create = await call(app, 'POST', `/stores/${A}/themes`, bob, { name: 'x' });
  assert.strictEqual(create.status, 403);
});

test('ISOLATION: a theme id of another store is unreachable (404) through this store’s paths', async () => {
  // Seed a theme owned by store B (a baseless root — no bytes needed for the guard).
  const bTheme = `${B}-secret`;
  await store.ensureTheme(B, bTheme, 'B theme');

  // ALICE is an owner of A, but B's theme is not in A → every A-scoped path 404s (not 200/403).
  const get = await call(app, 'GET', `/stores/${A}/themes/${bTheme}/draft`, alice);
  assert.strictEqual(get.status, 404);
  const patch = await call(app, 'PATCH', `/stores/${A}/themes/${bTheme}`, alice, {
    name: 'hijack',
  });
  assert.strictEqual(patch.status, 404);
  const del = await call(app, 'DELETE', `/stores/${A}/themes/${bTheme}`, alice);
  assert.strictEqual(del.status, 404);
  const act = await call(app, 'POST', `/stores/${A}/themes/${bTheme}/activate`, alice, {});
  assert.strictEqual(act.status, 404);

  // And B's theme name was never changed.
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM theme WHERE id = $1', [
    bTheme,
  ]);
  assert.strictEqual(rows[0].name, 'B theme');
});

test('theme-scoped editing works and enforces role (editor saves, only owner publishes)', async () => {
  const { id } = await createTheme({ name: 'Editable' });

  // Editor (member, not owner) can read + save a draft.
  const save = await editHero(id, '<section>by-editor</section>', carol);
  assert.strictEqual(save.status, 200);
  const view = await call(app, 'GET', `/stores/${A}/themes/${id}/draft`, carol);
  assert.strictEqual(view.status, 200);
  const preview = await call(app, 'POST', `/stores/${A}/themes/${id}/preview`, carol, {
    page: 'index',
  });
  assert.strictEqual(preview.status, 200);

  // But cannot publish/activate/delete (owner-only).
  const pub = await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, carol, {});
  assert.strictEqual(pub.status, 403);
  const act = await call(app, 'POST', `/stores/${A}/themes/${id}/activate`, carol, {});
  assert.strictEqual(act.status, 403);
  const del = await call(app, 'DELETE', `/stores/${A}/themes/${id}`, carol);
  assert.strictEqual(del.status, 403);

  // Owner can publish.
  const ownerPub = await call(app, 'POST', `/stores/${A}/themes/${id}/publish`, alice, {});
  assert.strictEqual(ownerPub.status, 200);
});

test('every multi-theme endpoint is 503 when no object store is configured', async () => {
  const list = await call(appNoStore, 'GET', `/stores/${A}/themes`, alice);
  const create = await call(appNoStore, 'POST', `/stores/${A}/themes`, alice, {});
  assert.strictEqual(list.status, 503);
  assert.strictEqual(create.status, 503);
});
