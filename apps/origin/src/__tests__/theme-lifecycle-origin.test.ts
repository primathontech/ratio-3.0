// The storefront reflects the theme LIFECYCLE: what the origin serves must track the store's live
// pointer as it moves — first publish, a second publish, and a rollback to the first. The admin-HTTP
// wrapper (create/edit/publish/activate/rollback routing + authz) is covered by
// admin-api theme-multi-api.test.ts; a single live publish is covered by theme-asset-origin.test.ts.
// The gap this guards: after publishing v2 and then rolling back to v1, the ORIGIN'S RENDERED HTML
// must show v2 then v1 — the render is bound to the live version, not the latest. In-process via
// app.fetch(), real PG + MinIO, driving the same ThemeStore primitives the admin routes call
// (publish → store.publish, activate/rollback → store.setLive).
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

const T = 'themelife_o1';
const THEME = 'themelife_o1_main';
const MARK = (v: string) => `LIFECYCLE_MARK_${v}`;
const identity = (s: Record<string, string>) => s;

// A root theme (no base) whose home page is a single section carrying a version marker.
const themeAt = (v: string) => ({
  'sections/hero.liquid': `<section id="hero">${MARK(v)}</section>`,
  'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
});

const home = () =>
  app.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': T } })
  );

let store: ThemeStore;

before(async () => {
  if (skip) return;
  const admin = new S3Client(common);
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [T]
  );
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.query(
    "INSERT INTO tenants (id, name, status) VALUES ($1, 'Theme Lifecycle', 'active')",
    [T]
  );

  store = new ThemeStore(new S3ObjectStore({ bucket, ...common }));
  await store.ensureTheme(T, THEME);
});

after(async () => {
  if (skip) return;
  await pool.query(
    'UPDATE tenants SET live_theme_id = NULL, live_theme_version = NULL WHERE id = $1',
    [T]
  );
  await pool.query('DELETE FROM theme WHERE id = $1', [THEME]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.end();
});

test(
  'the storefront serves the live version and tracks it through publish v2 → rollback',
  { skip },
  async () => {
    // Publish v1 (makes it live) → the storefront serves v1.
    await store.saveDraft({ themeId: THEME, tenantId: T }, themeAt('v1'));
    const p1 = await store.publish({ themeId: THEME, tenantId: T }, { compile: identity });
    assert.equal(p1.version, 1);

    const r1 = await home();
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-handler'), 'theme-bundle');
    const html1 = await r1.text();
    assert.match(html1, new RegExp(MARK('v1')), 'storefront shows v1');

    // Edit + publish v2 (now live) → the storefront switches to v2, and v1 is gone.
    await store.saveDraft({ themeId: THEME, tenantId: T }, themeAt('v2'));
    const p2 = await store.publish({ themeId: THEME, tenantId: T }, { compile: identity });
    assert.equal(p2.version, 2);

    const html2 = await (await home()).text();
    assert.match(html2, new RegExp(MARK('v2')), 'storefront shows v2 after the second publish');
    assert.doesNotMatch(html2, new RegExp(MARK('v1')), 'v1 is no longer served');

    // Roll back to v1 (the activate/rollback primitive) → the storefront reverts to v1, not the latest.
    await store.setLive(T, THEME, 1);
    const html3 = await (await home()).text();
    assert.match(html3, new RegExp(MARK('v1')), 'storefront reverts to v1 after rollback');
    assert.doesNotMatch(
      html3,
      new RegExp(MARK('v2')),
      'the rolled-back version is no longer served'
    );

    // The live pointer is at v1 while v2 still exists in history.
    const versions = await store.listVersions(T, THEME);
    assert.deepEqual(
      versions.map((v) => v.version),
      [2, 1],
      'both versions retained, newest first'
    );
  }
);
