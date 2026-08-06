// H-1 (OFCE-405): authored richText HTML must not execute. safeRichText is the sanitiser the page
// builder applies to authored HTML (builder-core doc.ts). Pure, deterministic.
import { test } from 'node:test';
import assert from 'node:assert';
import { safeRichText } from '@ratio/theme';

test('richText: <script> and attributed tags are neutralised', () => {
  const html = safeRichText('<script>alert(1)</script><p onclick="x()">hi</p>');
  assert.doesNotMatch(html, /<script/i); // no live script tag
  assert.doesNotMatch(html, /<[^>]*onclick/i); // no live tag carrying an onclick attribute
  assert.match(html, /&lt;script&gt;/); // escaped, inert
});

test('richText: bare allowlisted formatting tags are preserved', () => {
  const html = safeRichText('<p>Hello <strong>world</strong></p><ul><li>a</li></ul>');
  assert.match(html, /<p>Hello <strong>world<\/strong><\/p>/);
  assert.match(html, /<ul><li>a<\/li><\/ul>/);
});

test('richText: an img with onerror cannot be reconstructed', () => {
  const html = safeRichText('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/i); // no live img tag
  assert.doesNotMatch(html, /<[^>]*onerror/i); // no live tag carrying onerror
});
