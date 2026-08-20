import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOREFRONT_BASE_CSP } from '../handlers/helpers';

// OFCE-701: the base stylesheet is CDN-linked as an external <link href="/assets/<hash>"> on published
// stores. An external stylesheet is governed by style-src, and 'unsafe-inline' alone does NOT authorize
// it — so style-src MUST include 'self', or every published storefront renders unstyled. Guard that here
// (a CSP-level check, not an HTML-string assertion), while keeping the no-first-party-JS backstop.
test('storefront CSP permits the same-origin CDN base stylesheet and inline theme styles', () => {
  const styleSrc = STOREFRONT_BASE_CSP['style-src'];
  assert.ok(
    styleSrc.includes("'self'"),
    "style-src must allow 'self' for the linked /assets base css"
  );
  assert.ok(
    styleSrc.includes("'unsafe-inline'"),
    "style-src must keep 'unsafe-inline' for token/theme <style>"
  );
});

test('storefront CSP keeps script-src none (no first-party JS backstop)', () => {
  assert.deepEqual(STOREFRONT_BASE_CSP['script-src'], ["'none'"]);
});
