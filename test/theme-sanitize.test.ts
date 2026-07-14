// H-1 (OFCE-405): authored richText HTML must not execute, and link/image schemes must be
// validated (no javascript:/data:). Pure renderer, deterministic.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderPage } from '../packages/theme/index';

const tenant = { name: 'Acme', theme: { color: '#c0392b' } };
const render = (section: unknown) => renderPage({ sections: [section] } as never, { tenant });

test('richText: <script> and attributed tags are neutralised', () => {
  const html = render({
    kind: 'richText',
    html: '<script>alert(1)</script><p onclick="x()">hi</p>',
  });
  assert.doesNotMatch(html, /<script/i); // no live script tag
  assert.doesNotMatch(html, /<[^>]*onclick/i); // no live tag carrying an onclick attribute
  assert.match(html, /&lt;script&gt;/); // escaped, inert
});

test('richText: bare allowlisted formatting tags are preserved', () => {
  const html = render({
    kind: 'richText',
    html: '<p>Hello <strong>world</strong></p><ul><li>a</li></ul>',
  });
  assert.match(html, /<p>Hello <strong>world<\/strong><\/p>/);
  assert.match(html, /<ul><li>a<\/li><\/ul>/);
});

test('richText: an img with onerror cannot be reconstructed', () => {
  const html = render({ kind: 'richText', html: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/i); // no live img tag
  assert.doesNotMatch(html, /<[^>]*onerror/i); // no live tag carrying onerror
});

test('hero CTA: javascript: href is neutralised, relative href kept', () => {
  const evil = render({
    kind: 'hero',
    heading: 'H',
    cta: { label: 'Go', href: 'javascript:alert(1)' },
  });
  assert.doesNotMatch(evil, /href="javascript:/i);
  const ok = render({ kind: 'hero', heading: 'H', cta: { label: 'Go', href: '/sale' } });
  assert.match(ok, /href="\/sale"/);
});

test('product card: javascript:/data: in href/image are neutralised', () => {
  const html = render({
    kind: 'productGrid',
    products: [
      {
        title: 'X',
        price: 'Rs 1',
        href: 'javascript:x',
        image: 'data:text/html,<script>1</script>',
      },
    ],
  });
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /src="data:/i);
});
