// Bundle-theme authoring endpoints (OFCE-601, base ⊕ overrides): draft save/preview, publish,
// rollback. In-process via app.fetch(), real test DB, injected verifier. The store logic (compose,
// freeze, publish/rollback) is unit-tested in builder-core against MinIO; this covers the HTTP
// wrapper — routing, membership/owner authz, the derived one-theme-per-store id, and the 503 gate.
// S3 is an external service, so the ObjectStore is faked in-memory here (the DB is real).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../../app';
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
  // Mirror the real editor flow: scaffold (provisions the store's theme over the full-document base and
  // returns the composed tree), then save the WHOLE tree with the test's edits layered on top. This keeps
  // layout/theme.liquid in the published theme, so a publish satisfies the full-theme-ownership invariant
  // — the editor never saves a base-wiping partial.
  const got = (await (
    await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, headers, {})
  ).json()) as { files: Record<string, string>; revision: string };
  return call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, headers, {
    files: { ...got.files, ...files },
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
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN, tenantId: ID }), {
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
    await store.readDraft({ themeId: MAIN, tenantId: ID }),
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
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN, tenantId: ID }), {
    'a.liquid': 'legacy',
  });
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

const PREVIEW_LAYOUT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{{ site_name | escape }}</title>' +
  '<style>{{ base_css }}{{ token_css }}{{ theme_css }}</style></head>' +
  '<body>{{ header }}{{ content_for_layout }}{{ footer }}</body></html>';

test('preview renders a full styled document with the theme brand tokens + chrome (OFCE-618)', async () => {
  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/preview`, alice, {
    files: {
      'layout/theme.liquid': PREVIEW_LAYOUT,
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
  // The preview mirrors what the origin serves: the theme's own layout renders a full, STYLED document
  // so the wizard/editor preview reflects the merchant's brand colour/font — not bare body HTML.
  assert.ok(body.html?.startsWith('<!doctype html>'), 'a full document, not bare body HTML');
  assert.ok(body.html?.includes('--accent:#ff0000'), 'the theme brand colour reaches the head');
  assert.ok(body.html?.includes('--radius:18px'), 'the theme radius token reaches the head');
  assert.ok(body.html?.includes('<h1>Hi</h1>'), 'the section renders in content_for_layout');
  // The chrome (renderChrome → the layout's {{ header }}/{{ footer }} slots) shows the real store name,
  // via the built-in header fallback since the draft ships no header section.
  assert.match(
    body.html ?? '',
    /<header class="hdr">[\s\S]*hdr-brand[^>]*>ThemeBundle</,
    'the chrome header shows the real store name (matches the origin)'
  );
  assert.match(body.html ?? '', /<footer class="ftr">/, 'the chrome footer renders');
  assert.strictEqual(
    (body.html?.match(/<header class="hdr">/g) ?? []).length,
    1,
    'exactly one header, no double-wrap'
  );
});

test('preview: a full-document layout draft renders from the theme layout (no double-wrap)', async () => {
  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/preview`, alice, {
    files: {
      'layout/theme.liquid': PREVIEW_LAYOUT,
      'assets/base.css': '.probe{color:#0a0a0a}',
      'config/tokens.json': JSON.stringify({ radius: 'rounded' }),
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Owned' } }],
      }),
      'sections/hero.liquid': '<h1>{{ heading }}</h1>',
    },
    page: 'index',
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { html?: string };
  assert.ok(body.html?.startsWith('<!doctype html>'), 'a full document');
  assert.strictEqual((body.html?.match(/<html/gi) ?? []).length, 1, 'not double-wrapped');
  assert.ok(
    body.html?.includes('.probe{color:#0a0a0a}'),
    'the theme base.css is inlined by the layout'
  );
  assert.ok(body.html?.includes('--radius:18px'), 'origin token_css is placed by the layout');
  assert.ok(body.html?.includes('<h1>Owned</h1>'), 'the section renders in content_for_layout');
  assert.strictEqual(
    (body.html?.match(/<header class="hdr">/g) ?? []).length,
    1,
    'exactly one header (placed by the layout), no double-wrap'
  );
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

// OFCE-645 asset upload: a binary asset goes to the content-hash store; the draft's config/assets.json
// manifest gains an entry so it ships + freezes with the theme on publish.
const uploadAsset = (
  headers: Record<string, string>,
  path: string,
  file: File | null,
  route = `/stores/${ID}/theme/bundle/assets`
) => {
  const fd = new FormData();
  fd.append('path', path);
  if (file) fd.append('file', file);
  return app.fetch(new Request('http://cp' + route, { method: 'POST', headers, body: fd }));
};

test('upload a binary asset → stored in the content-hash store + added to the draft manifest', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // pretend-PNG
  const res = await uploadAsset(
    alice,
    'images/logo.png',
    new File([bytes], 'logo.png', { type: 'image/png' })
  );
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    path: string;
    asset: { hash: string; contentType: string; size: number };
  };
  assert.strictEqual(body.path, 'images/logo.png');
  assert.strictEqual(body.asset.contentType, 'image/png');
  assert.strictEqual(body.asset.size, bytes.byteLength);
  // The bytes are retrievable from the content-hash store.
  const back = await store.getAsset({ themeId: MAIN, tenantId: ID }, body.asset.hash);
  assert.ok(back && Buffer.from(back).equals(Buffer.from(bytes)), 'bytes stored + retrievable');
  // The draft manifest (config/assets.json) gained the entry — so it ships with the theme.
  const overrides = await store.readDraft({ themeId: MAIN, tenantId: ID });
  const manifest = JSON.parse(overrides['config/assets.json']) as Record<string, unknown>;
  assert.deepStrictEqual(manifest['images/logo.png'], body.asset);
  // A second upload to a different path co-exists in the manifest (read-modify-write, not clobber).
  await uploadAsset(
    alice,
    'favicon.ico',
    new File([new Uint8Array([1, 2])], 'favicon.ico', { type: 'image/x-icon' })
  );
  const overrides2 = await store.readDraft({ themeId: MAIN, tenantId: ID });
  const manifest2 = JSON.parse(overrides2['config/assets.json']) as Record<string, unknown>;
  assert.ok(manifest2['images/logo.png'] && manifest2['favicon.ico'], 'both assets kept');
});

test('upload rejects a scriptable content-type (415) — no stored-XSS surface', async () => {
  const svg = new File(['<svg onload="alert(1)"/>'], 'x.svg', { type: 'image/svg+xml' });
  const res = await uploadAsset(alice, 'x.svg', svg);
  assert.strictEqual(res.status, 415);
  const html = new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' });
  assert.strictEqual((await uploadAsset(alice, 'x.html', html)).status, 415);
});

test('upload rejects a traversal / reserved asset path (400)', async () => {
  const f = () => new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
  assert.strictEqual((await uploadAsset(alice, '../evil.png', f())).status, 400);
  assert.strictEqual((await uploadAsset(alice, '/abs.png', f())).status, 400);
  assert.strictEqual((await uploadAsset(alice, '__proto__', f())).status, 400);
});

test('upload rejects a missing file (400) and an oversize file (413)', async () => {
  assert.strictEqual((await uploadAsset(alice, 'a.png', null)).status, 400);
  const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
  assert.strictEqual((await uploadAsset(alice, 'big.png', big)).status, 413);
});

test('a 2 MB asset (over the global 1 MB body limit) uploads — the asset routes get a higher limit', async () => {
  // The global bodyLimit is 1 MB; a real font/image commonly exceeds that. The asset routes must carry
  // up to MAX_ASSET_BYTES, so this proves the per-route limit override actually takes effect (before the
  // fix, the global limiter 413'd this before the handler ran).
  const bytes = new Uint8Array(2 * 1024 * 1024).fill(7);
  const res = await uploadAsset(
    alice,
    'big.png',
    new File([bytes], 'big.png', { type: 'image/png' })
  );
  assert.strictEqual(res.status, 200, 'assets above the global 1 MB limit are allowed');
  const body = (await res.json()) as { asset: { size: number } };
  assert.strictEqual(body.asset.size, bytes.byteLength);
});

test('a non-member cannot upload an asset (403)', async () => {
  const res = await uploadAsset(
    bob,
    'a.png',
    new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
  );
  assert.strictEqual(res.status, 403);
});

// OFCE-632 asset manager: list + delete the theme's binary assets. Upload already exists (above);
// these complete the manage surface the editor's Assets view needs.
const listAssets = (headers: Record<string, string>, route = `/stores/${ID}/theme/bundle/assets`) =>
  app.fetch(new Request('http://cp' + route, { method: 'GET', headers }));
const deleteAsset = (
  headers: Record<string, string>,
  path: string,
  route = `/stores/${ID}/theme/bundle/assets`
) =>
  app.fetch(
    new Request('http://cp' + route + `?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers,
    })
  );

test('list assets returns the draft manifest entries (path + hash/type/size), sorted', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {}); // clean slate (drops manifest)
  await uploadAsset(
    alice,
    'images/logo.png',
    new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })
  );
  await uploadAsset(
    alice,
    'favicon.ico',
    new File([new Uint8Array([4, 5])], 'favicon.ico', { type: 'image/x-icon' })
  );
  const res = await listAssets(alice);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as {
    assets: { path: string; hash: string; contentType: string; size: number }[];
  };
  assert.deepStrictEqual(
    body.assets.map((a) => a.path),
    ['favicon.ico', 'images/logo.png'],
    'both assets, sorted by path'
  );
  const logo = body.assets.find((a) => a.path === 'images/logo.png')!;
  assert.strictEqual(logo.contentType, 'image/png');
  assert.strictEqual(logo.size, 3);
  assert.ok(/^[a-f0-9]{64}$/.test(logo.hash), 'the content hash');
});

test('delete an asset removes its manifest entry but KEEPS the content-hash bytes', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {});
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const up = (await (
    await uploadAsset(alice, 'images/x.png', new File([bytes], 'x.png', { type: 'image/png' }))
  ).json()) as { asset: { hash: string } };

  const del = await deleteAsset(alice, 'images/x.png');
  assert.strictEqual(del.status, 200);
  // Gone from the manifest / list.
  const list = (await (await listAssets(alice)).json()) as { assets: { path: string }[] };
  assert.ok(!list.assets.some((a) => a.path === 'images/x.png'), 'entry removed from the manifest');
  // The bytes are NOT deleted — content-addressed + immutable, still referenced by any published
  // version's frozen manifest (and possibly another path via dedup).
  const back = await store.getAsset({ themeId: MAIN, tenantId: ID }, up.asset.hash);
  assert.ok(back && Buffer.from(back).equals(Buffer.from(bytes)), 'bytes retained after delete');
});

test('delete a non-existent asset path → 404; missing path → 400', async () => {
  assert.strictEqual((await deleteAsset(alice, 'nope/missing.png')).status, 404);
  assert.strictEqual(
    (await deleteAsset(alice, '__proto__')).status,
    404,
    'prototype key is not an asset'
  );
  assert.strictEqual((await listAssets(alice, `/stores/${ID}/theme/bundle/assets`)).status, 200);
  const noPath = await app.fetch(
    new Request(`http://cp/stores/${ID}/theme/bundle/assets`, { method: 'DELETE', headers: alice })
  );
  assert.strictEqual(noPath.status, 400);
});

test('a non-member cannot list or delete assets (403)', async () => {
  assert.strictEqual((await listAssets(bob)).status, 403);
  assert.strictEqual((await deleteAsset(bob, 'images/logo.png')).status, 403);
});

// OFCE-632: serve a draft asset's raw bytes so the editor's Assets view can thumbnail an unpublished
// upload (the storefront origin only serves the LIVE theme's assets).
const rawAsset = (
  headers: Record<string, string>,
  path: string,
  route = `/stores/${ID}/theme/bundle/assets/raw`
) =>
  app.fetch(
    new Request('http://cp' + route + `?path=${encodeURIComponent(path)}`, {
      method: 'GET',
      headers,
    })
  );

test('raw-serve returns the draft asset bytes with its content-type + nosniff', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {});
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7]);
  await uploadAsset(alice, 'images/pic.png', new File([bytes], 'pic.png', { type: 'image/png' }));
  const res = await rawAsset(alice, 'images/pic.png');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const back = new Uint8Array(await res.arrayBuffer());
  assert.deepStrictEqual(back, bytes, 'the exact uploaded bytes come back');
});

test('raw-serve neutralizes a tampered manifest content-type (never serves text/html)', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {});
  // Upload a real (allowlisted) PNG, then hand-edit the draft manifest to claim text/html for it —
  // simulating a member editing config/assets.json in the code editor to smuggle stored HTML.
  const up = (await (
    await uploadAsset(
      alice,
      'images/x.png',
      new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' })
    )
  ).json()) as { asset: { hash: string; size: number } };
  const draft = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)
  ).json()) as {
    files: Record<string, string>;
    revision: string;
  };
  const tampered = {
    ...draft.files,
    'config/assets.json': JSON.stringify({
      'images/x.png': { hash: up.asset.hash, contentType: 'text/html', size: up.asset.size },
    }),
  };
  await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: tampered,
    revision: draft.revision,
  });
  const res = await rawAsset(alice, 'images/x.png');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(
    res.headers.get('content-type'),
    'application/octet-stream',
    'the tampered text/html type is neutralized, not served as active content'
  );
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
});

test('raw-serve 404s an unknown path, 400s a missing ?path, 403s a non-member', async () => {
  assert.strictEqual((await rawAsset(alice, 'nope/missing.png')).status, 404);
  const noPath = await app.fetch(
    new Request(`http://cp/stores/${ID}/theme/bundle/assets/raw`, { method: 'GET', headers: alice })
  );
  assert.strictEqual(noPath.status, 400);
  assert.strictEqual((await rawAsset(bob, 'images/pic.png')).status, 403);
});

// OFCE-654: draft-save structural validation (reject-on-save). putDraft merges the edit over the
// scaffolded full-document base, so only a genuinely-broken file trips the gate.
test('draft-save rejects malformed JSON in a theme file (400 + issue)', async () => {
  const res = await putDraft({ 'templates/index.json': '{ "sections": [ }' });
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { error: string; issues: { path: string; error: string }[] };
  assert.ok(
    body.issues.some((i) => i.path === 'templates/index.json' && /valid JSON/.test(i.error)),
    'the broken template JSON is reported'
  );
});

test('draft-save rejects a layout that dropped a platform slot (400)', async () => {
  const res = await putDraft({
    // full document, but no {{ content_for_header }} — islands/CSP/integration head would vanish
    'layout/theme.liquid': '<!doctype html><html><body>{{ content_for_layout }}</body></html>',
  });
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { issues: { path: string; error: string }[] };
  assert.ok(body.issues.some((i) => /content_for_header/.test(i.error)));
});

// OFCE-655: a developer edits the full theme (head + a script + a section), the save-gate catches a
// bad edit, and the good draft publishes → live. (Origin render of a published full-doc theme is
// covered by apps/origin theme-ownership-origin.test.ts.)
test('edit head + script + section → save-gate catches a bad edit → publish', async () => {
  await call(app, 'POST', `/stores/${ID}/theme/bundle/scaffold`, alice, {});
  const got = (await (
    await call(app, 'GET', `/stores/${ID}/theme/bundle/draft`, alice)
  ).json()) as {
    files: Record<string, string>;
    revision: string;
  };
  // Edit the <head> (add a script) AND a section — a whole-theme edit that keeps the platform slots.
  const edited = {
    ...got.files,
    'layout/theme.liquid': got.files['layout/theme.liquid'].replace(
      '</head>',
      '<script>window.__x=1</script></head>'
    ),
    'sections/hero.liquid': '<h1>edited hero</h1>',
  };
  const ok = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: edited,
    revision: got.revision,
  });
  assert.strictEqual(ok.status, 200, 'a valid full-theme edit saves');
  const rev2 = ((await ok.json()) as { hash: string }).hash;

  // A bad edit (layout drops content_for_layout) is caught at save, not left for publish.
  const bad = await call(app, 'PUT', `/stores/${ID}/theme/bundle/draft`, alice, {
    files: {
      ...edited,
      'layout/theme.liquid':
        '<!doctype html><html><head>{{ content_for_header }}</head><body></body></html>',
    },
    revision: rev2,
  });
  assert.strictEqual(bad.status, 400, 'the save-gate rejects the broken layout');

  // The good draft still publishes → live.
  const pub = await call(app, 'POST', `/stores/${ID}/theme/bundle/publish`, alice, {});
  assert.strictEqual(pub.status, 200, 'the valid draft publishes');
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
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN, tenantId: ID }), {
    'sections/hero.liquid': '<section>MINE</section>',
  });

  const res = await call(app, 'POST', `/stores/${ID}/theme/bundle/reset`, alice, {});
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { files: Record<string, string>; revision: string };

  // The override is gone — the stored draft is empty, so the composed theme is the pure base: the
  // customized section reverts to the base's own version (not the merchant's edit).
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN, tenantId: ID }), {});
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
  assert.deepStrictEqual(await store.readDraft({ themeId: MAIN, tenantId: ID }), {});
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
