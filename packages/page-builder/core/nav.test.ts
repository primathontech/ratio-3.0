// Header navigation: fetch (canonical, null on miss), href mapping (the one transform), and the
// rendered header — including the brand-only fallback and href/text safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMainMenu, renderHeader, navHref, type NavMenu } from './nav';

const item = (o: Partial<NavMenu['items'][number]> & { title: string }) => ({
  id: o.id ?? o.title,
  position: o.position ?? 0,
  depth: o.depth ?? 0,
  resource_type: o.resource_type ?? 'COLLECTION',
  resource_id: o.resource_id ?? null,
  external_url: o.external_url ?? null,
  relative_path: o.relative_path ?? null,
  url: o.url ?? '',
  items: o.items ?? [],
  ...o,
});

const sample: NavMenu = {
  handle: 'main-menu',
  title: 'Main Menu',
  items: [
    item({
      title: 'Hair Care',
      url: 'hair-care',
      items: [
        item({
          title: 'Product Type',
          depth: 1,
          url: 'shampoo',
          items: [item({ title: 'Shampoo', depth: 2, url: 'shampoo' })],
        }),
      ],
    }),
    item({
      title: 'Salon',
      position: 1,
      resource_type: 'HTTP',
      url: 'https://ex.com/s',
      external_url: 'https://ex.com/s',
    }),
    item({
      title: '<Evil>',
      position: 2,
      resource_type: 'HTTP',
      url: 'javascript:alert(1)',
      external_url: 'javascript:alert(1)',
    }),
  ],
};

test('navHref maps resource types to storefront links; neutralises unsafe urls', () => {
  assert.equal(navHref(sample.items[0]), '/collections/hair-care');
  assert.equal(navHref(sample.items[1]), 'https://ex.com/s');
  assert.equal(navHref(sample.items[2]), '#'); // javascript: url never reaches an href
});

test('renderHeader builds the nav with mega columns, escapes titles, opens externals in a new tab', () => {
  const html = renderHeader({ menu: sample, siteName: 'Acme' });
  assert.match(html, /<a class="hdr-brand" href="\/">Acme<\/a>/);
  assert.match(html, /href="\/collections\/hair-care"/);
  assert.match(html, /class="hdr-mega"/); // Hair Care has children → mega menu
  assert.match(html, /href="\/collections\/shampoo"/); // nested depth-2 link
  assert.match(html, /href="https:\/\/ex\.com\/s"[^>]*target="_blank"/); // external → new tab
  assert.match(html, /&lt;Evil&gt;/, 'title escaped');
  assert.ok(!html.includes('javascript:'), 'no javascript: href in output');
});

test('renderHeader with no menu → brand-only fallback (still a real header, no nav)', () => {
  const html = renderHeader({ menu: null, siteName: 'Acme' });
  assert.match(html, /class="hdr"/);
  assert.match(html, />Acme</);
  assert.ok(!html.includes('hdr-nav'), 'no nav element when there is no menu');
});

test('fetchMainMenu: menu on 200, null on 404 and on network error', async () => {
  const ok = (async () =>
    new Response(JSON.stringify(sample), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await fetchMainMenu('m', 'http://x/', ok))?.handle, 'main-menu');

  const notFound = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  assert.equal(await fetchMainMenu('m', 'http://x', notFound), null);

  const boom = (async () => {
    throw new Error('net');
  }) as unknown as typeof fetch;
  assert.equal(await fetchMainMenu('m', 'http://x', boom), null);
});
