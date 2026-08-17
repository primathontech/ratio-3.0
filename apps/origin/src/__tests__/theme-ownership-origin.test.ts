// OFCE-630 full theme ownership at the ORIGIN: with THEME_OWNS_DOCUMENT=1, a store whose published
// theme carries a full-document layout/theme.liquid renders ENTIRELY from that layout — the origin
// injects only the platform slice (content_for_header) and wraps nothing. A store whose theme is NOT a
// full document (old body-only layout, not yet rebased) still uses the legacy TS shell even with the
// flag on — the flag is a kill-switch, the layout shape is what self-migrates a store. In-process via
// app.fetch(), real Postgres + MinIO. Gated on BUNDLE_S3_ENDPOINT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore } from '@ratio/builder-core';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { app } from '../index';

const SECRET = resolveEdgeSecret(process.env);
const endpoint = process.env.BUNDLE_S3_ENDPOINT;
const bucket = process.env.BUNDLE_S3_BUCKET ?? 's2poc-test';
const credentials = {
  accessKeyId: process.env.BUNDLE_S3_KEY ?? 'poc',
  secretAccessKey: process.env.BUNDLE_S3_SECRET ?? 'poc12345',
};
const common = { endpoint, forcePathStyle: true, credentials, region: 'us-east-1' };
const skip = endpoint ? false : 'set BUNDLE_S3_ENDPOINT (MinIO) + a migrated DATABASE_URL';

// A full-document layout in the shape the base theme ships (head owns title + CSS layers + the platform
// content_for_header slice; body owns chrome + content_for_layout + the platform content_for_body_end).
const FULL_DOC_LAYOUT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{ page_title | default: site_name | default: 'Store' | escape }}</title>
  <style>{{ base_css }}{{ token_css }}{{ theme_css }}</style>
  {{ content_for_header }}
</head>
<body>
{{ header }}
{{ content_for_layout }}
{{ footer }}
{{ content_for_body_end }}
</body>
</html>`;

const TA = 'themeown_a';
const THEMEA = 'themeown_a_main';
const TB = 'themeown_b';
const THEMEB = 'themeown_b_main';
const TC = 'themeown_c'; // a store rebased from a body-only base onto a full-document base
const THEMEC = 'themeown_c_main';
const BLIB = '_themeown_lib'; // a base-owning library tenant
const BASEC = 'themeown_c_base';
const edge = (extra: Record<string, string> = {}) => ({ 'x-edge-auth': SECRET, ...extra });
const call = (path: string, headers: Record<string, string>) =>
  app.fetch(new Request('http://origin' + path, { headers }));

let priorFlag: string | undefined;

before(async () => {
  if (skip) return;
  priorFlag = process.env.THEME_OWNS_DOCUMENT;
  process.env.THEME_OWNS_DOCUMENT = '1';

  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  for (const id of [THEMEA, THEMEB, THEMEC, BASEC])
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  for (const id of [TA, TB, TC, BLIB]) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Owned Store', 'active')", [
    TA,
  ]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Legacy Store', 'active')", [
    TB,
  ]);
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'Rebase Lib')", [BLIB]);
  await pool.query(
    "INSERT INTO tenants (id, name, status) VALUES ($1, 'Rebased Store', 'active')",
    [TC]
  );

  const store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));

  // TA — a full-document layout theme: the theme owns the whole page.
  await store.ensureTheme(TA, THEMEA);
  await store.saveDraft(
    { themeId: THEMEA, tenantId: TA },
    {
      'layout/theme.liquid': FULL_DOC_LAYOUT,
      'assets/base.css': '.probe-base{color:#123456}',
      'config/tokens.json': JSON.stringify({ radius: 'rounded' }), // → --radius:18px in token_css
      'sections/header.liquid': '<header class="hdr">{{ site_name | escape }}</header>',
      'sections/footer.liquid': '<footer class="ftr">the footer</footer>',
      'sections/hero.liquid': '<section class="hero"><h1>{{ heading | escape }}</h1></section>',
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Owned' } }],
      }),
    }
  );
  await store.publish({ themeId: THEMEA, tenantId: TA }, { compile: (s) => s });

  // TB — an old body-only layout (a store not yet rebased): flag on, but NOT a full document.
  await store.ensureTheme(TB, THEMEB);
  await store.saveDraft(
    { themeId: THEMEB, tenantId: TB },
    {
      'layout/theme.liquid': '{{ content_for_layout }}',
      'sections/hero.liquid': '<section class="hero"><h1>{{ heading | escape }}</h1></section>',
      'templates/index.json': JSON.stringify({
        sections: [{ type: 'hero', data: { heading: 'Legacy' } }],
      }),
    }
  );
  await store.publish({ themeId: THEMEB, tenantId: TB }, { compile: (s) => s });

  // TC — the Phase-1 migration end-to-end. A base library ships v1 (body-only layout); a store adopts
  // it + overrides its hero + goes live (so it's on the OLD body-only layout). The base then publishes
  // v2 (full-document layout), and the store is REBASED onto it. After rebase the origin must render the
  // store via the layout, with the merchant's hero edit preserved and the new base footer live.
  const baseSections = {
    'sections/hero.liquid': '<h1>base hero</h1>',
    'sections/header.liquid': '<header class="hdr">{{ site_name | escape }}</header>',
    'sections/footer.liquid': '<footer class="ftr">v2 footer</footer>',
    'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
  };
  await store.ensureTheme(BLIB, BASEC, 'Base');
  await store.saveDraft(
    { themeId: BASEC, tenantId: BLIB },
    { 'layout/theme.liquid': '{{ content_for_layout }}', ...baseSections } // v1: body-only
  );
  await store.publish({ themeId: BASEC, tenantId: BLIB }, { compile: (s) => s, makeLive: false });
  await store.ensureTheme(TC, THEMEC, 'Store', { themeId: BASEC, version: 1 });
  await store.saveDraft(
    { themeId: THEMEC, tenantId: TC },
    { 'sections/hero.liquid': '<h1>MY rebased hero</h1>' }
  );
  await store.publish({ themeId: THEMEC, tenantId: TC }, { compile: (s) => s }); // live on v1 body-only
  await store.saveDraft(
    { themeId: BASEC, tenantId: BLIB },
    { 'layout/theme.liquid': FULL_DOC_LAYOUT, ...baseSections } // v2: full document
  );
  await store.publish({ themeId: BASEC, tenantId: BLIB }, { compile: (s) => s, makeLive: false });
  await store.rebaseToBase(TC, THEMEC, { compile: (s) => s });
});

after(async () => {
  if (skip) return;
  if (priorFlag === undefined) delete process.env.THEME_OWNS_DOCUMENT;
  else process.env.THEME_OWNS_DOCUMENT = priorFlag;
  for (const id of [THEMEA, THEMEB, THEMEC, BASEC])
    await pool.query('DELETE FROM theme WHERE id = $1', [id]);
  for (const id of [TA, TB, TC, BLIB]) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
});

test(
  'flag on + full-document layout: the theme owns the whole page (no TS shell wrap)',
  { skip },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': TA }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    assert.equal(res.headers.get('x-theme-render'), 'layout', 'rendered from the theme layout');
    const body = await res.text();

    assert.match(body, /^<!doctype html>/i, 'a full document');
    assert.equal(
      (body.match(/<html/gi) ?? []).length,
      1,
      'exactly one <html> — not double-wrapped'
    );
    // The theme's OWN base.css is inlined by the layout (proof the design-system CSS moved into the theme).
    assert.match(
      body,
      /\.probe-base\{color:#123456\}/,
      'the theme inlines its own assets/base.css'
    );
    // The brand tokens the origin computed flow in as token_css (config/tokens.json radius:rounded).
    assert.match(body, /--radius:18px/, 'origin token_css is placed by the layout');
    // The <title> and chrome come from the theme layout, populated by the origin (store name + nav).
    assert.match(body, /<title>Owned Store<\/title>/, 'the theme owns the escaped title');
    assert.match(
      body,
      /<header class="hdr">Owned Store<\/header>/,
      'chrome header, placed by the layout'
    );
    assert.equal((body.match(/<header class="hdr">/g) ?? []).length, 1, 'exactly one header');
    assert.match(
      body,
      /<footer class="ftr">the footer<\/footer>/,
      'chrome footer, placed by the layout'
    );
    assert.match(
      body,
      /<section class="hero"><h1>Owned<\/h1><\/section>/,
      'sections in content_for_layout'
    );
  }
);

test(
  'e2e: a store rebased from a body-only base onto a full-document base now renders via the layout',
  { skip },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': TC }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    assert.equal(
      res.headers.get('x-theme-render'),
      'layout',
      'after rebase the store renders via the full-document layout'
    );
    const body = await res.text();
    assert.match(body, /^<!doctype html>/i, 'a full document');
    assert.equal((body.match(/<html/gi) ?? []).length, 1, 'not double-wrapped');
    assert.match(
      body,
      /<h1>MY rebased hero<\/h1>/,
      'the merchant edit is preserved through the rebase'
    );
    assert.match(body, /<footer class="ftr">v2 footer<\/footer>/, 'the new base footer is live');
    assert.match(
      body,
      /<header class="hdr">Rebased Store<\/header>/,
      'chrome from the rebased base, placed by the layout'
    );
  }
);

test(
  'flag on + a body-only (un-rebased) theme: still the legacy TS shell, not the layout',
  { skip },
  async () => {
    const res = await call('/', edge({ 'x-ratio-tenant': TB }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'theme-bundle');
    assert.equal(res.headers.get('x-theme-render'), 'shell', 'not a full document → legacy shell');
    const body = await res.text();
    assert.match(body, /^<!doctype html>/i, 'the legacy shell still produces a document');
    assert.match(body, /<h1>Legacy<\/h1>/, 'the section renders inside the shell');
  }
);
