// OFCE-641 Phase 3: the order/thank-you page (GET /order) renders through the theme's OWN
// layout/theme.liquid — the order section flows into content_for_layout and chrome into the header/
// footer slots — NOT the retired TS shell. In-process via app.fetch(), real Postgres + MinIO. Gated on
// BUNDLE_S3_ENDPOINT.
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

const T = 'orderpage_o1';
const THEME = 'orderpage_o1_main';
// A second tenant with NO live bundle theme, to exercise the degrade path (liveCompiled → null).
const T_NOBUNDLE = 'orderpage_o2';
let store: ThemeStore;

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await pool.query('UPDATE tenants SET live_theme_id=NULL, live_theme_version=NULL WHERE id=$1', [
    T,
  ]);
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Order Store', 'active')", [
    T,
  ]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T_NOBUNDLE]);
  await pool.query(
    "INSERT INTO tenants (id, name, status) VALUES ($1, 'No Bundle Store', 'active')",
    [T_NOBUNDLE]
  );

  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(T, THEME);
  await store.saveDraft(
    { themeId: THEME, tenantId: T },
    {
      // Full-document layout with a distinctive marker + the theme's own CSS, so we can prove the order
      // page went through THIS layout (not a TS shell). It references the platform-owned slots
      // (content_for_header / content_for_body_end) so the layout render exercises them.
      'layout/theme.liquid':
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        "<title>{{ page_title | default: site_name | default: 'Store' | escape }}</title>" +
        '<style>{{ base_css }}{{ token_css }}{{ theme_css }}</style>{{ content_for_header }}</head>' +
        '<body><div class="LAYOUT_MARK">{{ header }}{{ content_for_layout }}{{ footer }}</div>' +
        '{{ content_for_body_end }}</body></html>',
      'assets/base.css': '.probe-order{color:#abcabc}',
      // The editable thank-you section renders the order context (total in paise → money filter).
      'sections/order.liquid':
        '<main class="order"><h1>Thanks {{ order_id }}</h1><p>{{ total | money }} via {{ payment_method }}</p></main>',
    }
  );
  await store.publish({ themeId: THEME, tenantId: T }, { compile: (s) => s }); // makes it live
});

after(async () => {
  if (skip) return;
  await pool.query('UPDATE tenants SET live_theme_id=NULL, live_theme_version=NULL WHERE id=$1', [
    T,
  ]);
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T_NOBUNDLE]);
  await pool.end();
});

test(
  'the order page renders through the theme layout (not the retired TS shell)',
  { skip },
  async () => {
    const res = await app.fetch(
      new Request('http://origin/order?id=ORD-9&total=499&payment=UPI', {
        headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': T },
      })
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-handler'), 'order');
    assert.equal(res.headers.get('x-theme-render'), 'layout', 'rendered through the theme layout');
    const body = await res.text();
    assert.match(body, /^<!doctype html>/i, 'a full document');
    assert.match(body, /class="LAYOUT_MARK"/, 'rendered through the THEME layout, not a TS shell');
    assert.match(
      body,
      /\.probe-order\{color:#abcabc\}/,
      'the theme base.css is inlined by the layout'
    );
    assert.match(
      body,
      /<title>Order confirmed · Order Store<\/title>/,
      'the order page_title reaches the layout head'
    );
    // The editable order section rendered in content_for_layout, with the rupee-formatted total.
    assert.match(body, /Thanks ORD-9/, 'the order section renders the order id');
    assert.match(body, /₹499\.00 via UPI/, 'total (rupees→paise→money) + payment method render');
    assert.equal(res.headers.get('x-cache'), 'no-store', 'per-order, not cached');
  }
);

// When the store has NO full-document live theme (not on a bundle theme, or a transient theme-store
// load failure — liveCompiled → null), the order page must NOT silently degrade to a headless fragment:
// renderThemeLayout({}) would return just the order body with no <head>, dropping the CSS and the
// GoKwik purchase pixel's slot. The order page is uncacheable (no-store), so the edge can't shield this.
// It must fall back to the built-in full-document wrapper.
test(
  'the order page degrades to a full document when there is no bundle theme',
  { skip },
  async () => {
    const res = await app.fetch(
      new Request('http://origin/order?id=ORD-2&total=150&payment=COD', {
        headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': T_NOBUNDLE },
      })
    );
    assert.equal(res.status, 200, 'a just-paid shopper is never blocked over a missing theme');
    assert.equal(res.headers.get('x-handler'), 'order');
    assert.equal(
      res.headers.get('x-theme-render'),
      'fallback',
      'the built-in degrade wrapper fired'
    );
    const body = await res.text();
    assert.match(body, /^<!doctype html>/i, 'a FULL document, not a headless fragment');
    // The <head> is where the brand CSS and the GoKwik purchase-pixel slot live — its presence is the
    // guard against the silent renderThemeLayout({}) → bare-fragment regression.
    assert.match(body, /<\/head>/i, 'the document has a head (CSS + integration slots survive)');
    assert.match(body, /<title>Order confirmed · No Bundle Store<\/title>/, 'the built-in title');
    assert.match(body, />ORD-2</, 'the order id still renders');
    assert.match(body, /₹150\.00/, 'the total still renders');
    assert.equal(res.headers.get('x-cache'), 'no-store', 'per-order, not cached');
  }
);
