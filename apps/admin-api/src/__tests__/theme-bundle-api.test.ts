// Bundle-theme authoring endpoints (OFCE-601, base ⊕ overrides): draft save/preview, publish,
// rollback. In-process via app.fetch(), real test DB, injected verifier. The store logic (compose,
// freeze, publish/rollback) is unit-tested in builder-core against MinIO; this covers the HTTP
// wrapper — routing, membership/owner authz, the derived one-theme-per-store id, and the 503 gate.
// S3 is an external service, so the ObjectStore is faked in-memory here (the DB is real).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../app';
import { ThemeStore, DEFAULT_BASE_THEME_ID } from '@ratio/builder-core';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_tb'; // owner
const BOB = 'user_bob_tb'; // no membership
const CAROL = 'user_carol_tb'; // member (editor), not owner
const verify = async (token: string) =>
  token === 'tok-alice'
    ? { userId: ALICE }
    : token === 'tok-bob'
      ? { userId: BOB }
      : token === 'tok-carol'
        ? { userId: CAROL }
        : null;

// An in-memory ObjectStore — the bundle bytes live here instead of S3/MinIO. `clear()` wipes it
// between tests (the DB rows are reset in beforeEach; the object bytes must be reset too, else a draft
// saved by one test leaks into the next).
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
// A second app with NO bundle store wired — exercises the 503 gate.
const appNoStore = createApp(verify, { bundleThemes: null });

const ID = 't_theme_bundle';
const MAIN = `${ID}-main`;
const ONBOARD_ID = 't_theme_onboard';
const ONBOARD_MAIN = `${ONBOARD_ID}-main`;
const ONBOARD_HOST = 'tb-onboard.localhost';
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

// Save a draft the way the editor does: read the current revision, then PUT with it. Used for the
// setup saves whose point isn't the concurrency check (the CAS tests below pass revisions explicitly).
async function putDraft(files: Record<string, string>, headers = alice) {
  const got = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, headers)
  ).json()) as { revision: string };
  return call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, headers, {
    files,
    revision: got.revision,
  });
}

async function cleanup() {
  await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [MAIN]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [ID]);
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [ID]
  );
  await pool.query('DELETE FROM theme WHERE id = $1', [MAIN]);
  await pool.query('DELETE FROM memberships WHERE tenant_id = $1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [ID]);
  // The onboarding-route test creates a whole store (tenant + host + membership + pages + theme).
  {
    const tid = ONBOARD_ID;
    const main = ONBOARD_MAIN;
    await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [main]);
    await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [tid]);
    await pool.query('DELETE FROM pages WHERE tenant_id = $1', [tid]);
    await pool.query('DELETE FROM domains WHERE tenant_id = $1', [tid]);
    await pool.query('DELETE FROM theme WHERE id = $1', [main]);
    await pool.query('DELETE FROM memberships WHERE tenant_id = $1', [tid]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tid]);
  }
  // The shared Default base (library-default / _library) is left in place — a persistent, idempotent
  // fixture that adoption re-freezes on demand; deleting it would race other suites that also adopt it.
}

before(async () => {
  await cleanup();
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'ThemeBundle')`, [ID]);
  await pool.query(
    `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
    [ALICE, ID]
  );
  await pool.query(
    `INSERT INTO memberships (clerk_user_id, tenant_id, role) VALUES ($1, $2, 'editor')`,
    [CAROL, ID]
  );
});
beforeEach(async () => {
  // Reset this store's theme rows and wipe the object bytes between tests (so one test's draft/version
  // can't leak into the next). The shared base's DB rows survive, so the next adoption re-freezes its
  // bytes on demand (ensureDefaultBaseTheme self-heals a fresh store) and composes over a real base.
  await pool.query('DELETE FROM theme_bundle_version WHERE theme_id = $1', [MAIN]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [ID]);
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [ID]
  );
  await pool.query('DELETE FROM theme WHERE id = $1', [MAIN]);
  objects.clear();
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('draft save stores only the delta from base (base ⊕ overrides), not a full copy', async () => {
  // Adopt the base, then read the full composed tree the editor works with.
  await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const composed = (
    (await (await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)).json()) as {
      files: Record<string, string>;
    }
  ).files;

  // The merchant changes ONE section and saves the whole composed tree back.
  const edited = { ...composed, 'sections/hero.liquid': '<section>MINE</section>' };
  const save = await putDraft(edited);
  assert.strictEqual(save.status, 200);

  // GET draft = base ⊕ overrides: the edit wins, untouched base files still compose in.
  const view = (
    (await (await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)).json()) as {
      files: Record<string, string>;
    }
  ).files;
  assert.strictEqual(view['sections/hero.liquid'], '<section>MINE</section>');
  assert.ok(view['layout/theme.liquid'], 'the base layout still composes in');

  // The stored OVERRIDES are ONLY the delta — just the one edited section, not a full base copy.
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN }), {
    'sections/hero.liquid': '<section>MINE</section>',
  });
});

test('a stale draft save is rejected with 409 (optimistic concurrency, no silent clobber)', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const loaded = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)
  ).json()) as {
    files: Record<string, string>;
    revision: string;
  };
  assert.ok(loaded.revision, 'GET draft returns a revision token');

  // Editor A saves an edit against the revision it loaded → wins.
  const a = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { ...loaded.files, 'sections/hero.liquid': '<section>A</section>' },
    revision: loaded.revision,
  });
  assert.strictEqual(a.status, 200);

  // Editor B, still holding the ORIGINAL revision, saves over A → must be rejected, not silently win.
  const b = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { ...loaded.files, 'sections/hero.liquid': '<section>B</section>' },
    revision: loaded.revision,
  });
  assert.strictEqual(b.status, 409);

  // A's edit survived; B's was not applied.
  const now = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)
  ).json()) as {
    files: Record<string, string>;
  };
  assert.strictEqual(now.files['sections/hero.liquid'], '<section>A</section>');
});

test('a draft save with the current revision succeeds, and the revision advances', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const first = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)
  ).json()) as {
    files: Record<string, string>;
    revision: string;
  };
  const save = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { ...first.files, 'sections/hero.liquid': '<section>edit</section>' },
    revision: first.revision,
  });
  assert.strictEqual(save.status, 200);
  const next = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)
  ).json()) as {
    revision: string;
  };
  assert.notStrictEqual(next.revision, first.revision, 'the revision moves after a save');

  // The now-current revision saves cleanly (no false conflict).
  const again = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { ...first.files, 'sections/hero.liquid': '<section>edit2</section>' },
    revision: next.revision,
  });
  assert.strictEqual(again.status, 200);
});

test('a draft save without a revision is rejected with 400 (fail loud, no blind write)', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const res = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: { 'sections/hero.liquid': '<section>no-rev</section>' },
  });
  assert.strictEqual(res.status, 400);
});

test('owner publishes → 200 with version 1 and the tenant live pointer moves', async () => {
  await putDraft({ 'index.liquid': 'HELLO' });
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(((await pub.json()) as { version: number }).version, 1);

  const { rows } = await pool.query<{ live_theme_id: string; live_theme_version: number }>(
    'SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1',
    [ID]
  );
  assert.strictEqual(rows[0].live_theme_id, MAIN);
  assert.strictEqual(rows[0].live_theme_version, 1);
});

test('OFCE-616: onboarding a store publishes + activates its bundle theme (live pointer set)', async () => {
  const res = await call(app, 'POST', '/stores', alice, {
    id: ONBOARD_ID,
    name: 'Onboarded',
    host: ONBOARD_HOST,
    color: '#0ea5e9',
  });
  assert.strictEqual(res.status, 201);

  // The store renders through the bundle from the moment it exists: live_theme_id points at the
  // adopted default theme's freshly-published version (not NULL → not the page-builder fallback).
  const { rows } = await pool.query<{
    live_theme_id: string | null;
    live_theme_version: number | null;
  }>('SELECT live_theme_id, live_theme_version FROM tenants WHERE id = $1', [ONBOARD_ID]);
  assert.strictEqual(rows[0].live_theme_id, ONBOARD_MAIN);
  assert.strictEqual(rows[0].live_theme_version, 1);
  const versions = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM theme_bundle_version WHERE theme_id = $1',
    [ONBOARD_MAIN]
  );
  assert.strictEqual(versions.rows[0].n, 1, 'exactly one published version at onboarding');
});

test('a non-owner cannot save a draft (403) or publish (403)', async () => {
  const draft = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, bob, { files: {} });
  assert.strictEqual(draft.status, 403);
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, bob, {});
  assert.strictEqual(pub.status, 403);
});

test('owner rolls back to an earlier version → 200 and the pointer moves back', async () => {
  await putDraft({ 'a.liquid': 'v1' });
  await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {}); // v1
  await putDraft({ 'a.liquid': 'v2' });
  await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {}); // v2

  const rb = await call(app, 'POST', `/stores/${ID}/theme/bundle/rollback`, alice, { version: 1 });
  assert.strictEqual(rb.status, 200);

  const { rows } = await pool.query<{ live_theme_version: number }>(
    'SELECT live_theme_version FROM tenants WHERE id = $1',
    [ID]
  );
  assert.strictEqual(rows[0].live_theme_version, 1);
});

test('rollback to an unknown version → 404', async () => {
  await putDraft({ 'a.liquid': 'v1' });
  await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {}); // v1
  const rb = await call(app, 'POST', `/stores/${ID}/theme/bundle/rollback`, alice, { version: 99 });
  assert.strictEqual(rb.status, 404);
});

test('a member (non-owner) can save/preview a draft but cannot publish or rollback', async () => {
  const save = await putDraft({ 'a.liquid': 'by-editor' }, carol);
  assert.strictEqual(save.status, 200);
  const view = await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, carol);
  assert.strictEqual(view.status, 200);
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, carol, {});
  assert.strictEqual(pub.status, 403);
  const rb = await call(app, 'POST', `/stores/${ID}/theme/bundle/rollback`, carol, { version: 1 });
  assert.strictEqual(rb.status, 403);
});

test('scaffold adopts the shared Default base (base ⊕ overrides), not a per-store copy', async () => {
  const first = await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  assert.strictEqual(first.status, 200);
  const body1 = (await first.json()) as { files: Record<string, string>; seeded: boolean };
  assert.strictEqual(body1.seeded, true);
  // The composed theme has the default files — supplied by the base, not copied per-store.
  assert.ok(body1.files['layout/theme.liquid'], 'composed theme has a layout (from the base)');
  assert.ok(
    body1.files['templates/index.json'],
    'composed theme has a home template (from the base)'
  );

  // Adoption: the store theme tracks the shared base, and keeps NO per-store copy (overrides empty).
  const { rows } = await pool.query<{ base_theme_id: string | null }>(
    'SELECT base_theme_id FROM theme WHERE id = $1',
    [MAIN]
  );
  assert.strictEqual(rows[0].base_theme_id, DEFAULT_BASE_THEME_ID, 'theme tracks the base');
  assert.deepStrictEqual(
    await store.readDraft({ themeId: MAIN }),
    {},
    'no per-store copy — overrides are empty'
  );

  // Second call: the theme already exists → no re-adopt.
  const second = await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const body2 = (await second.json()) as { seeded: boolean };
  assert.strictEqual(body2.seeded, false);
});

test('a legacy baseless theme (no base) can still save a draft and keeps its baseless identity', async () => {
  // Back-compat: a theme row that predates base adoption (base_theme_id NULL, a self-contained root
  // theme) must keep working. ensureStoreTheme skips it (the row already exists) and never forces it
  // onto the shared base — ensureTheme is create-only. A baseless theme stores the whole tree as its
  // "overrides" (diff from an empty base), so the save round-trips exactly what the editor sent.
  await store.ensureTheme(ID, MAIN, 'Theme');
  const save = await putDraft({ 'a.liquid': 'legacy' });
  assert.strictEqual(save.status, 200);
  const { rows } = await pool.query<{ base_theme_id: string | null }>(
    'SELECT base_theme_id FROM theme WHERE id = $1',
    [MAIN]
  );
  assert.strictEqual(
    rows[0].base_theme_id,
    null,
    'a legacy root theme keeps its baseless identity'
  );
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN }), { 'a.liquid': 'legacy' });
});

test('preview renders a page to HTML through the theme render path (layout + section + data)', async () => {
  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/preview`, alice, {
    files: {
      'layout/theme.liquid': '<html><body>{{ content_for_layout }}</body></html>',
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Hi there' } }],
      }),
      'sections/hero.liquid': '<h1>{{ heading }}</h1>',
    },
    page: 'index',
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { html?: string };
  assert.ok(body.html?.includes('Hi there'), 'renders the section with its data');
  assert.ok(body.html?.includes('<body>'), 'wraps the content in the layout');
});

test('preview wraps sections in the storefront head with the theme brand tokens (OFCE-618)', async () => {
  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/preview`, alice, {
    files: {
      'config/tokens.json': JSON.stringify({ color: '#ff0000', radius: 'rounded' }),
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Hi' } }],
      }),
      'sections/hero.liquid': '<h1>{{ heading }}</h1>',
    },
    page: 'index',
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { html?: string };
  // The preview must be a full, STYLED document that mirrors what the origin serves — otherwise the
  // wizard/editor preview is bare body HTML and never reflects the merchant's brand colour/font.
  assert.ok(body.html?.startsWith('<!doctype html>'), 'a full document, not bare body HTML');
  assert.ok(body.html?.includes('--accent:#ff0000'), 'the theme brand colour reaches the head');
  assert.ok(body.html?.includes('--radius:18px'), 'the theme radius token reaches the head');
  assert.ok(body.html?.includes('<h1>Hi</h1>'), 'the section still renders in the body');
});

test('preview surfaces a render error as { error } (200, not a 500)', async () => {
  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/preview`, alice, {
    files: { 'layout/theme.liquid': '<html></html>' }, // no templates/index.json → render throws
    page: 'index',
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, 'a template error comes back as a message, not a crash');
});

test('publish with no saved draft → 400 (publish does not create the theme)', async () => {
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  assert.strictEqual(pub.status, 400);
});

test('reset drops all overrides → the draft composes to pure base again', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const composed = (
    (await (await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)).json()) as {
      files: Record<string, string>;
    }
  ).files;

  // Customize one section, then confirm the override is stored.
  await putDraft({ ...composed, 'sections/hero.liquid': '<section>MINE</section>' });
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN }), {
    'sections/hero.liquid': '<section>MINE</section>',
  });

  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {});
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { files: Record<string, string>; revision: string };

  // The override is gone — the stored draft is empty, so the composed theme is the pure base: the
  // customized section reverts to the base's own version (not the merchant's edit).
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN }), {});
  assert.ok(body.files['layout/theme.liquid'], 'the reply composes the base layout back in');
  assert.notStrictEqual(
    body.files['sections/hero.liquid'],
    '<section>MINE</section>',
    'the customization is dropped'
  );
  assert.strictEqual(
    body.files['sections/hero.liquid'],
    composed['sections/hero.liquid'],
    'the section reverts to the base version'
  );
});

test('a member (non-owner) can reset a draft to base', async () => {
  await putDraft({ 'a.liquid': 'by-editor' }, carol);
  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, carol, {});
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN }), {});
});

test('every bundle endpoint is 503 when no object store is configured', async () => {
  const put = await call(appNoStore, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: {},
  });
  const get = await call(appNoStore, 'GET', `/stores/${ID}/theme/bundle/draft`, alice);
  const pub = await call(appNoStore, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  const rb = await call(appNoStore, 'POST', `/stores/${ID}/theme/bundle/rollback`, alice, {
    version: 1,
  });
  const reset = await call(appNoStore, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {});
  assert.strictEqual(put.status, 503);
  assert.strictEqual(get.status, 503);
  assert.strictEqual(pub.status, 503);
  assert.strictEqual(rb.status, 503);
  assert.strictEqual(reset.status, 503);
});
