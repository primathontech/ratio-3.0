// renderChrome renders the storefront header/footer from the THEME (so a merchant can edit them),
// falling back to the built-in chrome when a theme carries no header/footer section. The default
// theme's header/footer sections must reproduce the built-in markup and be driven by the sanitized
// menu/footer link data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { renderChrome, chromeLinks } from '../storefront/chrome';
import { defaultBundleTheme } from '../theme/default-theme';
import type { NavMenu, NavItem } from '../storefront/nav';

// The untrusted renderer the origin uses; here the trusted engine is fine — the chrome sections only
// use allowlisted filters (escape/default), so output is identical.
const renderer = (liquid: string, data: Record<string, unknown>) =>
  render(liquid, data, { trusted: true });

const item = (over: Partial<NavItem> & { title: string }): NavItem => ({
  id: over.title,
  position: 0,
  depth: 0,
  resource_type: 'COLLECTION',
  resource_id: null,
  external_url: null,
  relative_path: null,
  url: over.title.toLowerCase(),
  ...over,
});

const menu: NavMenu = {
  handle: 'main-menu',
  title: 'Main',
  items: [
    item({ title: 'Shop', url: 'shop' }),
    item({
      title: 'Hair',
      url: 'hair',
      items: [item({ title: 'Shampoo', position: 0 }), item({ title: 'Serum', position: 1 })],
    }),
  ],
};

test('renderChrome renders the theme header/footer with the store name and nav', async () => {
  const { header, footer } = await renderChrome(defaultBundleTheme(), renderer, {
    menu,
    footer: null,
    siteName: 'Acme',
  });
  assert.match(header, /<header class="hdr">/, 'the theme header renders');
  assert.match(header, /hdr-brand[^>]*>Acme</, 'the real store name is the brand');
  assert.match(header, /href="\/collections\/shop"[^>]*>Shop</, 'a top-level nav link renders');
  assert.match(header, /Shampoo/, 'a dropdown child link renders');
  assert.match(header, /class="hdr-actions"/, 'the search/cart/account actions render');
  assert.match(footer, /<footer class="ftr">/, 'the theme footer renders');
  assert.match(footer, /© Acme · powered by Ratio/, 'the footer legal line uses the store name');
});

test('renderChrome reflects an edit to the theme header (editability)', async () => {
  const files = defaultBundleTheme();
  files['sections/header.liquid'] =
    '<header class="hdr">MY CUSTOM HEADER {{ site_name | escape }}</header>';
  const { header } = await renderChrome(files, renderer, { menu, footer: null, siteName: 'Acme' });
  assert.match(header, /MY CUSTOM HEADER Acme/, 'the merchant edit takes effect');
});

test('renderChrome falls back to the built-in chrome when the theme has no header/footer section', async () => {
  // An older theme (or the bare base) with no chrome sections must still get a real header/footer.
  const { header, footer } = await renderChrome({}, renderer, {
    menu,
    footer: null,
    siteName: 'Acme',
  });
  assert.match(
    header,
    /<header class="hdr">[\s\S]*hdr-brand[^>]*>Acme</,
    'built-in header renders'
  );
  assert.match(footer, /<footer class="ftr">/, 'built-in footer renders');
});

test('chromeLinks sanitizes hrefs (safe schemes only) and maps resource types to routes', () => {
  const links = chromeLinks({
    handle: 'm',
    title: 'M',
    items: [
      item({ title: 'Coll', resource_type: 'COLLECTION', url: 'summer' }),
      item({ title: 'Evil', resource_type: 'HTTP', external_url: 'javascript:alert(1)' }),
      item({ title: 'Ext', resource_type: 'HTTP', external_url: 'https://example.com' }),
    ],
  });
  assert.equal(links[0].href, '/collections/summer', 'COLLECTION → internal route');
  assert.equal(links[1].href, '#', 'a javascript: url is neutralized');
  assert.equal(links[2].href, 'https://example.com', 'an http(s) url passes through');
  assert.equal(links[2].external, true, 'external flag set for http(s)');
  assert.equal(links[0].external, false, 'internal links are not external');
});

// OFCE-647: the header/footer sections resolve {{ path | asset_url }} too — a header logo is the most
// common use, and renderChrome is the shared chrome path on every page, so it must inject asset_urls.
test('header + footer sections resolve asset_url from the theme manifest', async () => {
  const h = 'c'.repeat(64);
  const compiled = {
    'config/assets.json': JSON.stringify({
      'logo.png': { hash: h, contentType: 'image/png', size: 1 },
    }),
    'sections/header.liquid': `<header><img src="{{ 'logo.png' | asset_url }}"></header>`,
    'sections/footer.liquid': `<footer><img src="{{ 'logo.png' | asset_url }}"></footer>`,
  };
  const { header, footer } = await renderChrome(compiled, renderer, {
    menu: null,
    footer: null,
    siteName: 'S',
  });
  assert.match(
    header,
    new RegExp(`<img src="/assets/${h}">`),
    'header logo resolves to /assets/<hash>'
  );
  assert.match(footer, new RegExp(`<img src="/assets/${h}">`), 'footer resolves too');
});
