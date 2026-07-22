// Track 4 — page builder. Proves: save-time validation (second enforcement point after
// registration), version pinning, save→purge orchestration (loud purge failures), shell
// composition (islands stay placeholders, tier = max over shell widgets), and the FULL D38 loop
// end-to-end: edit → save → purge → next visit re-renders — over the real lazy-edge algorithm.
// Run: node --import tsx --test test/page-builder.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageDoc, InvalidPageDoc, type PageDoc } from '../packages/page-builder/doc';
import { PageBuilder, InMemoryPageStore, PurgeFailed } from '../packages/page-builder/builder';
import { composePage } from '../packages/page-builder/compose';
import { PageOrigin } from '../packages/page-builder/origin-render';
import { WidgetRegistry, defaultRegistry } from '../packages/widget-registry/registry';
import { FakeAkamaiCache, type PurgeLike } from '../packages/edge-port/akamai-cache';
import { handleLazy, type LazyEdgeDeps } from '../packages/edge-port/lazy-edge';
import { FakeKV, FakeR2 } from '../packages/spine/stores';

const heroPage = (path: string, heading: string): PageDoc => ({
  path,
  title: 'Home',
  widgets: [{ id: 'w1', type: 'hero', data: { hero: { heading } } }],
});

// ─── validation ──────────────────────────────────────────────────────────────

test('validate: unknown widget, undeclared data, reserved path, dup ids — all reported at once', () => {
  const reg = defaultRegistry();
  const bad: PageDoc = {
    path: '/cart/extras',
    widgets: [
      { id: 'a', type: 'ghost', data: {} },
      { id: 'b', type: 'hero', data: { hero: {}, settings: { theme: 'x' } } },
      { id: 'b', type: 'hero', data: { hero: {} } },
    ],
  };
  try {
    validatePageDoc(bad, reg);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof InvalidPageDoc);
    const all = e.problems.join(' | ');
    assert.match(all, /reserved/);
    assert.match(all, /unknown widget 'ghost'/);
    assert.match(all, /undeclared data: settings/);
    assert.match(all, /duplicate/);
  }
});

test('validate: canonicalizes the path and pins widget versions', () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(heroPage('/About//', 'hi'), reg);
  assert.equal(doc.path, '/About', 'path canonicalized like the edge key (P9 — same fn)');
  assert.equal(doc.widgets[0].version, 1, 'version pinned at save');
});

test('validate: a later widget version cannot silently change a saved page', async () => {
  const reg = new WidgetRegistry();
  reg.register(
    {
      type: 'promo',
      template: '<p>v1:{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: true }
  );
  const pinned = validatePageDoc(
    { path: '/p', widgets: [{ id: 'a', type: 'promo', data: { promo: { text: 'x' } } }] },
    reg
  );
  reg.register(
    {
      type: 'promo',
      template: '<p>v2:{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: true }
  );
  const { html } = await composePage(pinned, reg);
  assert.match(html, /v1:x/, 'pinned page still renders the version it was saved with');

  const repinned = validatePageDoc(pinned, reg); // re-save = pin latest... only if unpinned
  assert.equal(repinned.widgets[0].version, 1, 'explicit pins survive re-validation');
});

// ─── compose ─────────────────────────────────────────────────────────────────

test('compose: widgets render in order; title escapes; islands runtime ships; tier = shell max', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      title: 'A<b>&"shop"',
      widgets: [
        { id: 'h', type: 'hero', data: { hero: { heading: 'Hi' } } },
        { id: 'g', type: 'productGrid', data: { grid: { products: [] } } },
      ],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(page.html, /<title>A&lt;b&gt;&amp;&quot;shop&quot;<\/title>/);
  assert.ok(
    page.html.indexOf('class="hero"') < page.html.indexOf('class="grid"'),
    'document order'
  );
  assert.match(page.html, /<script src="\/assets\/islands\.js" defer>/);
  assert.equal(page.tier, 'per-segment', 'grid uses money → per-segment beats hero static');
  assert.equal(page.cacheable, true);
});

test('compose: an island widget contributes ONLY its placeholder — per-user template never touches the shell', async () => {
  const reg = defaultRegistry();
  reg.register(
    {
      type: 'greeting',
      template: '<p>Hello {{ user.name | escape }}</p>',
      bindings: [{ name: 'user', tier: 'per-user' }],
      island: { name: 'greeting' },
    },
    { trusted: false }
  );
  const doc = validatePageDoc(
    {
      path: '/',
      widgets: [
        { id: 'w1', type: 'hero', data: { hero: { heading: 'Hi' } } },
        { id: 'w2', type: 'greeting', data: {} },
      ],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(page.html, /<div data-island="greeting" data-params="instance=w2">/);
  assert.ok(!page.html.includes('Hello'), 'island TEMPLATE did not render into the shell');
  assert.equal(page.tier, 'static', 'island does not raise the shell tier');
});

// ─── save→purge orchestration ────────────────────────────────────────────────

class CountingPurge implements PurgeLike {
  invalidated: string[][] = [];
  fail = false;
  async invalidateByTags(tags: string[]) {
    if (this.fail) throw new Error('CCU 403');
    this.invalidated.push(tags);
  }
  async deleteByTags() {}
}

test('builder: save purges the page tag; themeChanged purges ONE tenant tag', async () => {
  const purge = new CountingPurge();
  const b = new PageBuilder(new InMemoryPageStore(), defaultRegistry(), purge);
  await b.save('t_acme', heroPage('/p', 'v1'));
  assert.deepEqual(purge.invalidated[0], ['p.t_acme.%2Fp']);
  await b.themeChanged('t_acme');
  assert.deepEqual(purge.invalidated[1], ['t.t_acme']);
});

test('builder: purge failure is LOUD and the save is still durable (editor retries purge, not data)', async () => {
  const purge = new CountingPurge();
  purge.fail = true;
  const store = new InMemoryPageStore();
  const b = new PageBuilder(store, defaultRegistry(), purge);
  await assert.rejects(() => b.save('t_acme', heroPage('/p', 'v1')), PurgeFailed);
  assert.ok(await store.get('t_acme', '/p'), 'content saved despite failed purge');
});

test('builder: removing a missing page is a clean no-op (no purge)', async () => {
  const purge = new CountingPurge();
  const b = new PageBuilder(new InMemoryPageStore(), defaultRegistry(), purge);
  assert.equal(await b.remove('t_acme', '/ghost'), false);
  assert.equal(purge.invalidated.length, 0);
});

// ─── the full D38 loop, end-to-end over the real lazy edge ──────────────────

function pipeline() {
  const now = 1_000_000;
  const kv = new FakeKV();
  const cache = new FakeAkamaiCache(() => now);
  const registry = defaultRegistry();
  const store = new InMemoryPageStore();
  const origin = new PageOrigin(store, registry);
  const builder = new PageBuilder(store, registry, cache); // FakeAkamaiCache IS the PurgeLike
  const pending: Promise<unknown>[] = [];
  const deps: LazyEdgeDeps = {
    kv,
    cache,
    lastGood: new FakeR2(),
    origin,
    colo: 'BOM',
    waitUntil: (p) => pending.push(p),
  };
  const visit = (path: string) =>
    handleLazy({ method: 'GET', url: `https://acme.example${path}`, host: 'acme.example' }, deps);
  return { kv, builder, origin, visit, settle: () => Promise.all(pending.splice(0)) };
}

test('e2e: publish → visit → edit → purge → revalidate — the whole D38 lifecycle', async () => {
  const p = pipeline();
  await p.kv.put('host:acme.example', JSON.stringify({ status: 'active', tenantId: 't_acme' }));

  await p.builder.save('t_acme', heroPage('/', 'Welcome v1'));
  const first = await p.visit('/');
  assert.equal(first.served, 'MISS');
  assert.match(first.body, /Welcome v1/);
  assert.equal((await p.visit('/')).served, 'HIT', 'second visit: zero origin work');
  assert.equal(p.origin.renders, 1);

  await p.builder.save('t_acme', heroPage('/', 'Welcome v2')); // edit → save → purge
  const after = await p.visit('/');
  assert.equal(after.served, 'REVALIDATED');
  assert.match(after.body, /Welcome v2/, 'the edit is live on the very next visit');
  assert.equal((await p.visit('/')).served, 'HIT');
  assert.equal(p.origin.renders, 2, 'exactly one re-render per edit');
});

test('e2e: deleted page 404s on next visit and the 404 itself caches', async () => {
  const p = pipeline();
  await p.kv.put('host:acme.example', JSON.stringify({ status: 'active', tenantId: 't_acme' }));
  await p.builder.save('t_acme', heroPage('/gone', 'alive'));
  await p.visit('/gone');

  await p.builder.remove('t_acme', '/gone');
  const after = await p.visit('/gone');
  assert.equal(after.status, 404, 'deleted page 404s after purge');
  assert.equal((await p.visit('/gone')).served, 'HIT', 'the 404 caches like any page');
});

test('e2e: never-visited pages cost NOTHING at publish (lazy, not materialized)', async () => {
  const p = pipeline();
  await p.kv.put('host:acme.example', JSON.stringify({ status: 'active', tenantId: 't_acme' }));
  for (let i = 0; i < 50; i++) await p.builder.save('t_acme', heroPage(`/p${i}`, `page ${i}`));
  assert.equal(p.origin.renders, 0, '50 pages published, zero renders — the D38 point');
  await p.visit('/p7');
  assert.equal(p.origin.renders, 1, 'only the visited page ever renders');
});
