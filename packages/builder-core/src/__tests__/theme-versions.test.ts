// Theme versioning (ADR-013 §13) against the real test DB. Provisions its own tenant + pages.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { pool } from '@ratio/data-db';
import { PgThemeStore, ThemeConflict } from '../theme-versions';
import { PgPageStore } from '../store-pg';
import type { PageDoc } from '../doc';

const T = 't_theme_ver';
const themeStore = new PgThemeStore();
const pageStore = new PgPageStore();

const homeDoc = (path: string, title: string): PageDoc => ({
  path,
  title,
  sections: [{ id: 'h', type: 'hero', data: { hero: { heading: title } } }],
});

before(async () => {
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'ThemeCo') ON CONFLICT (id) DO NOTHING`,
    [T]
  );
});

beforeEach(async () => {
  await pool.query('DELETE FROM pages WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM theme_versions WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [T]);
  await pool.query(
    `UPDATE tenants SET theme = '{"colorPrimary":"#111"}'::jsonb, published_theme_version = NULL WHERE id = $1`,
    [T]
  );
});

after(async () => {
  await pool.query('DELETE FROM pages WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM theme_versions WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id = $1', [T]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [T]);
  await pool.end();
});

test('publishTheme promotes drafts→live, snapshots pages + tokens as v1, moves the pointer', async () => {
  await pageStore.saveDraft(T, homeDoc('/', 'Home v1'));
  const { version } = await themeStore.publishTheme(T, { by: 'ram', note: 'first' });

  assert.strictEqual(version, 1);
  assert.strictEqual(await themeStore.publishedVersion(T), 1);
  assert.strictEqual((await pageStore.getLive(T, '/'))?.title, 'Home v1', 'draft promoted to live');

  const m = await themeStore.getVersion(T, 1);
  assert.strictEqual(m?.pages['/'].title, 'Home v1', 'page captured in the snapshot');
  assert.strictEqual(
    (m?.tokens as { colorPrimary?: string }).colorPrimary,
    '#111',
    'tokens captured'
  );
});

test('a second publish creates v2 and leaves v1 immutable (keep-all history)', async () => {
  await pageStore.saveDraft(T, homeDoc('/', 'Home v1'));
  await themeStore.publishTheme(T);
  await pageStore.saveDraft(T, homeDoc('/', 'Home v2'));
  const { version } = await themeStore.publishTheme(T);

  assert.strictEqual(version, 2);
  assert.strictEqual(
    (await themeStore.getVersion(T, 1))?.pages['/'].title,
    'Home v1',
    'v1 unchanged'
  );
  assert.strictEqual((await themeStore.getVersion(T, 2))?.pages['/'].title, 'Home v2');
  assert.deepStrictEqual(
    (await themeStore.listVersions(T)).map((h) => h.version),
    [2, 1],
    'both kept, newest first'
  );
});

test('rollbackTheme repoints and restores live state + tokens from the snapshot', async () => {
  await pageStore.saveDraft(T, homeDoc('/', 'Home v1'));
  await themeStore.publishTheme(T);
  await pool.query(`UPDATE tenants SET theme = '{"colorPrimary":"#f00"}'::jsonb WHERE id = $1`, [
    T,
  ]);
  await pageStore.saveDraft(T, homeDoc('/', 'Home v2'));
  await themeStore.publishTheme(T);

  const r = await themeStore.rollbackTheme(T, 1);

  assert.strictEqual(r.version, 1);
  assert.strictEqual(await themeStore.publishedVersion(T), 1, 'pointer moved back');
  assert.strictEqual((await pageStore.getLive(T, '/'))?.title, 'Home v1', 'live restored');
  const { rows } = await pool.query<{ theme: { colorPrimary: string } }>(
    'SELECT theme FROM tenants WHERE id = $1',
    [T]
  );
  assert.strictEqual(rows[0].theme.colorPrimary, '#111', 'tokens restored');
  assert.deepStrictEqual(
    (await themeStore.listVersions(T)).map((h) => h.version),
    [2, 1],
    'rollback keeps all versions (roll forward still possible)'
  );
});

test('rollback un-publishes pages that did not exist in the snapshot', async () => {
  await pageStore.saveDraft(T, homeDoc('/', 'Home'));
  await themeStore.publishTheme(T); // v1 = { / }
  await pageStore.saveDraft(T, homeDoc('/about', 'About'));
  await themeStore.publishTheme(T); // v2 = { /, /about }
  assert.ok(await pageStore.getLive(T, '/about'), '/about is live at v2');

  await themeStore.rollbackTheme(T, 1);

  assert.strictEqual(await pageStore.getLive(T, '/about'), null, '/about un-published (not in v1)');
  assert.ok(await pageStore.getLive(T, '/'), '/ still live');
});

test('publishTheme with a stale expectedBase raises ThemeConflict (optimistic concurrency)', async () => {
  await pageStore.saveDraft(T, homeDoc('/', 'A'));
  await themeStore.publishTheme(T); // v1, pointer = 1
  await pageStore.saveDraft(T, homeDoc('/', 'B'));

  await assert.rejects(
    () => themeStore.publishTheme(T, { expectedBase: 0 }), // editor still thought it was unpublished
    (e) => e instanceof ThemeConflict
  );
  // publishing against the correct base succeeds
  const { version } = await themeStore.publishTheme(T, { expectedBase: 1 });
  assert.strictEqual(version, 2);
});
