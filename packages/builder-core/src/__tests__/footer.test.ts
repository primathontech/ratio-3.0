// Storefront footer: fetch (canonical, fallback on miss), and the rendered footer — including the
// EMPTY-response case (legal line only) and href/text safety. Mirrors the header (nav) contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFooter, renderFooter, FALLBACK_FOOTER, type FooterMenu } from '../footer';

const item = (o: Partial<FooterMenu['items'][number]> & { title: string }) => ({
  id: o.id ?? o.title,
  position: o.position ?? 0,
  depth: o.depth ?? 0,
  resource_type: o.resource_type ?? 'PAGE',
  resource_id: o.resource_id ?? null,
  external_url: o.external_url ?? null,
  relative_path: o.relative_path ?? null,
  url: o.url ?? '',
  items: o.items ?? [],
  ...o,
});

const okFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test('the fallback footer is empty for now (renders the legal line only)', () => {
  assert.deepEqual(FALLBACK_FOOTER.items, []);
});

test('fetchFooter falls back when unconfigured (no base url or no merchant)', async () => {
  assert.equal(await fetchFooter('m1', ''), FALLBACK_FOOTER);
  assert.equal(await fetchFooter('', 'https://api'), FALLBACK_FOOTER);
});

test('fetchFooter falls back on a non-200 (e.g. a merchant with no footer)', async () => {
  const f = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  assert.equal(await fetchFooter('m1', 'https://api', f), FALLBACK_FOOTER);
});

test('fetchFooter returns the backend menu UNCHANGED on success', async () => {
  const menu: FooterMenu = {
    handle: 'footer-menu',
    title: 'Footer',
    items: [item({ title: 'Help' })],
  };
  const got = await fetchFooter('m1', 'https://api/', okFetch(menu));
  assert.deepEqual(got, menu);
});

test('fetchFooter sends the gk-merchant-id header to the footer-menu endpoint', async () => {
  let seenUrl = '';
  let seenMerchant = '';
  const f = (async (url: string, init?: RequestInit) => {
    seenUrl = url;
    seenMerchant = (init?.headers as Record<string, string>)['gk-merchant-id'];
    return new Response(JSON.stringify(FALLBACK_FOOTER), { status: 200 });
  }) as unknown as typeof fetch;
  await fetchFooter('merch-9', 'https://api', f);
  assert.match(seenUrl, /\/api\/v1\/storefront\/nav-menus\/footer-menu$/);
  assert.equal(seenMerchant, 'merch-9');
});

test('renderFooter always renders the legal line with the store name', () => {
  const html = renderFooter({ footer: FALLBACK_FOOTER, siteName: 'Acme' });
  assert.match(html, /<footer class="ftr">/);
  assert.match(html, /© Acme · powered by Ratio/);
});

test('an empty footer renders the legal line but no columns', () => {
  const html = renderFooter({ footer: FALLBACK_FOOTER, siteName: 'Acme' });
  assert.doesNotMatch(html, /ftr-cols/);
});

test('a footer with items renders columns of links, hrefs mapped + escaped', () => {
  const menu: FooterMenu = {
    handle: 'footer-menu',
    title: 'Footer',
    items: [
      item({
        title: 'Help',
        items: [item({ title: 'Contact', depth: 1, resource_type: 'PAGE', url: 'contact' })],
      }),
      item({
        title: 'Insta',
        position: 1,
        resource_type: 'HTTP',
        external_url: 'https://ig.com/x',
      }),
    ],
  };
  const html = renderFooter({ footer: menu, siteName: 'Acme' });
  assert.match(html, /ftr-cols/);
  assert.match(html, /href="\/pages\/contact"/); // PAGE mapped to our route
  assert.match(html, /href="https:\/\/ig.com\/x" target="_blank"/); // external opens in a new tab
  assert.match(html, />Help</);
});

test('renderFooter neutralises an unsafe href from backend data', () => {
  const menu: FooterMenu = {
    handle: 'footer-menu',
    title: 'Footer',
    items: [item({ title: 'Evil', resource_type: 'HTTP', external_url: 'javascript:alert(1)' })],
  };
  const html = renderFooter({ footer: menu, siteName: 'Acme' });
  assert.doesNotMatch(html, /href="javascript:/);
});
