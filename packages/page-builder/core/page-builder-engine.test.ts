// Page-builder engine (spine-free): save-time validation (second enforcement point after
// registration, incl. rich-HTML sanitization), version pinning, and shell composition
// (islands stay placeholders, tier = max over shell sections). Persistence, purge, and the
// full edge lifecycle live in later slices; this covers doc + compose only.
// Run: node --import tsx --test test/page-builder-engine.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageDoc, InvalidPageDoc, type PageDoc } from '@ratio/page-builder-core/doc';
import { composePage } from '@ratio/page-builder-core/compose';
import { SectionRegistry, defaultRegistry } from '@ratio/page-builder-registry/registry';

const heroPage = (path: string, heading: string): PageDoc => ({
  path,
  title: 'Home',
  sections: [{ id: 'w1', type: 'hero', data: { hero: { heading } } }],
});

// ─── validation ──────────────────────────────────────────────────────────────

test('validate: unknown section, undeclared data, reserved path, dup ids — all reported at once', () => {
  const reg = defaultRegistry();
  const bad: PageDoc = {
    path: '/cart/extras',
    sections: [
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
    assert.match(all, /unknown section 'ghost'/);
    assert.match(all, /undeclared data: settings/);
    assert.match(all, /duplicate/);
  }
});

test('validate: canonicalizes the path and pins section versions', () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(heroPage('/About//', 'hi'), reg);
  assert.equal(doc.path, '/About', 'path canonicalized like the edge key (P9 — same fn)');
  assert.equal(doc.sections[0].version, 1, 'version pinned at save');
});

test('validate: a later section version cannot silently change a saved page', async () => {
  const reg = new SectionRegistry();
  reg.register(
    {
      type: 'promo',
      template: '<p>v1:{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: true }
  );
  const pinned = validatePageDoc(
    { path: '/p', sections: [{ id: 'a', type: 'promo', data: { promo: { text: 'x' } } }] },
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

  const repinned = validatePageDoc(pinned, reg);
  assert.equal(repinned.sections[0].version, 1, 'explicit pins survive re-validation');
});

test('validate: rich HTML is sanitized AT SAVE — script/attribute vectors never reach storage (finding #8)', () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/rich',
      sections: [
        {
          id: 'r1',
          type: 'richText',
          data: {
            rich: {
              html: '<p>fine</p><script>alert(1)</script><img src=x onerror=alert(2)><b>bold</b>',
            },
          },
        },
      ],
    },
    reg
  );
  const html = (doc.sections[0].data.rich as { html: string }).html;
  assert.match(html, /<p>fine<\/p>/, 'allowlisted formatting survives');
  assert.match(html, /<b>bold<\/b>/, 'allowlisted formatting survives');
  assert.ok(!html.includes('<script>'), 'script tag neutralized');
  assert.ok(!/<img[^&]/.test(html), 'attribute-bearing tag stays escaped');
  assert.match(html, /&lt;script&gt;/, 'escaped, not silently dropped (author sees their input)');
});

// ─── compose ─────────────────────────────────────────────────────────────────

test('compose: sections render in order; title escapes; islands runtime ships; tier = shell max', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      title: 'A<b>&"shop"',
      sections: [
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

test('compose: an island section contributes ONLY its placeholder — per-user template never touches the shell', async () => {
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
      sections: [
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

// ─── nested section → block ────────────────────────────────────────────────────

test('compose: a section renders its child blocks in order, inside its wrapper', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      sections: [
        {
          id: 's1',
          type: 'slideshow',
          data: {},
          blocks: [
            { id: 'b1', type: 'slide', data: { slide: { heading: 'First' } } },
            { id: 'b2', type: 'slide', data: { slide: { heading: 'Second' } } },
          ],
        },
      ],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(
    page.html,
    /<section class="slideshow">.*First.*Second.*<\/section>/s,
    'child blocks nested in document order inside the section wrapper'
  );
  assert.equal(page.tier, 'static');
});

test('validate: a section rejects a block type it does not accept', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        {
          path: '/',
          sections: [
            {
              id: 's1',
              type: 'slideshow',
              data: {},
              blocks: [{ id: 'b1', type: 'hero', data: {} }],
            },
          ],
        },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc && /does not accept block 'hero'/.test(e.problems.join(' '))
  );
});

test('validate: blocks on a section that accepts none are rejected', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        {
          path: '/',
          sections: [
            {
              id: 's1',
              type: 'hero',
              data: { hero: { heading: 'x' } },
              blocks: [{ id: 'b1', type: 'slide', data: { slide: {} } }],
            },
          ],
        },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc && /does not accept blocks/.test(e.problems.join(' '))
  );
});

test('validate: a block with undeclared data is rejected; a valid block pins its version', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        {
          path: '/',
          sections: [
            {
              id: 's1',
              type: 'slideshow',
              data: {},
              blocks: [{ id: 'b1', type: 'slide', data: { slide: {}, bogus: 1 } }],
            },
          ],
        },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc &&
      /block 'b1' \(slide\) supplies undeclared data: bogus/.test(e.problems.join(' '))
  );

  const doc = validatePageDoc(
    {
      path: '/',
      sections: [
        {
          id: 's1',
          type: 'slideshow',
          data: {},
          blocks: [{ id: 'b1', type: 'slide', data: { slide: { heading: 'x' } } }],
        },
      ],
    },
    reg
  );
  assert.equal(doc.sections[0].blocks?.[0].version, 1, 'block version pinned at save');
});

// ─── typed settings (Slice 2b) ──────────────────────────────────────────────────

test('settings: valid typed values pass', () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      sections: [
        {
          id: 'h',
          type: 'hero',
          data: { hero: { heading: 'Hi', cta: { label: 'Shop', href: '/shop' } } },
        },
      ],
    },
    reg
  );
  assert.equal(doc.sections[0].type, 'hero');
});

test('settings: a wrong-typed value is rejected with the setting key', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        { path: '/', sections: [{ id: 'h', type: 'hero', data: { hero: { heading: 42 } } }] },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc &&
      /setting 'hero.heading' must be a string/.test(e.problems.join(' '))
  );
});

test('settings: a non-URL (e.g. javascript:) link setting is rejected', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        {
          path: '/',
          sections: [
            {
              id: 'h',
              type: 'hero',
              data: { hero: { heading: 'Hi', cta: { href: 'javascript:alert(1)' } } },
            },
          ],
        },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc &&
      /setting 'hero.cta.href' must be an absolute URL/.test(e.problems.join(' '))
  );
});

test('settings: block setting types are validated too', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        {
          path: '/',
          sections: [
            {
              id: 's1',
              type: 'slideshow',
              data: {},
              blocks: [{ id: 'b1', type: 'slide', data: { slide: { image: 5 } } }],
            },
          ],
        },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc &&
      /setting 'slide.image' must be a string/.test(e.problems.join(' '))
  );
});

// ─── library breadth (Slice 2c) ─────────────────────────────────────────────────

test('compose: a basic page built from library sections renders all of them', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      title: 'Store',
      sections: [
        { id: 'h', type: 'hero', data: { hero: { heading: 'Welcome' } } },
        { id: 'hd', type: 'heading', data: { heading: { text: 'New in' } } },
        { id: 'im', type: 'image', data: { image: { src: '/banner.jpg', alt: 'Banner' } } },
        { id: 'bt', type: 'button', data: { button: { label: 'Shop', href: '/shop' } } },
        { id: 'sp', type: 'spacer', data: { spacer: { size: 40 } } },
      ],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(page.html, /class="heading">New in/);
  assert.match(page.html, /class="image"><img src="\/banner\.jpg"/);
  assert.match(page.html, /class="button" href="\/shop">Shop/);
  assert.match(page.html, /class="spacer" style="height:40px"/);
  assert.equal(page.tier, 'static');
  assert.equal(page.cacheable, true);
});

test('settings: library block validation — bad button URL and out-of-range spacer are rejected', () => {
  const reg = defaultRegistry();
  assert.throws(
    () =>
      validatePageDoc(
        {
          path: '/',
          sections: [{ id: 'bt', type: 'button', data: { button: { href: 'javascript:1' } } }],
        },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc &&
      /setting 'button.href' must be an absolute URL/.test(e.problems.join(' '))
  );
  assert.throws(
    () =>
      validatePageDoc(
        { path: '/', sections: [{ id: 'sp', type: 'spacer', data: { spacer: { size: 9999 } } }] },
        reg
      ),
    (e: unknown) =>
      e instanceof InvalidPageDoc &&
      /setting 'spacer.size' must be <= 200/.test(e.problems.join(' '))
  );
});

// ─── theme / CSS (Slice 3) ──────────────────────────────────────────────────────

test('theme: composed page ships the storefront stylesheet + a content wrapper', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      title: 'T',
      sections: [{ id: 'h', type: 'hero', data: { hero: { heading: 'Hi' } } }],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(
    page.html,
    /<style>[^]*\.hero\{[^]*<\/style>/,
    'base storefront CSS injected into head'
  );
  assert.match(page.html, /<main class="rt">/, 'content wrapped for layout');
  assert.match(page.html, /name="viewport"/, 'responsive viewport meta present');
});

test('theme: a valid hex brand colour is applied; anything else is dropped (no CSS injection)', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    { path: '/', sections: [{ id: 'h', type: 'hero', data: { hero: { heading: 'Hi' } } }] },
    reg
  );
  const ok = await composePage(doc, reg, { color: '#e11d48' });
  assert.match(ok.html, /--accent:#e11d48/, 'hex brand colour overrides the token');
  const bad = await composePage(doc, reg, { color: 'red;}body{display:none' });
  assert.ok(
    !bad.html.includes('display:none'),
    'a malicious brand-colour value is dropped, never injected'
  );
  assert.ok(!/--accent:red/.test(bad.html), 'a non-hex brand colour is ignored');
});

test('theme: scale knobs map to tokens; off-scale values are ignored; ink auto-contrasts', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    { path: '/', sections: [{ id: 'h', type: 'hero', data: { hero: { heading: 'Hi' } } }] },
    reg
  );
  const dark = await composePage(doc, reg, {
    color: '#111111',
    bodyFont: 'serif',
    baseSize: 'l',
    radius: 'square',
    container: 'wide',
  });
  assert.match(dark.html, /--accent-ink:#ffffff/, 'dark brand → white ink');
  assert.match(dark.html, /--font:Georgia/, 'serif body font stack applied');
  assert.match(dark.html, /--base:18px/, 'large base size applied');
  assert.match(dark.html, /--radius:0px/, 'square radius applied');
  assert.match(dark.html, /--maxw:1200px/, 'wide container applied');

  const light = await composePage(doc, reg, { color: '#fef08a', bodyFont: 'comic-evil' });
  assert.match(light.html, /--accent-ink:#111827/, 'light brand → dark ink');
  assert.ok(!light.html.includes('comic-evil'), 'an off-scale font key is ignored');
});
