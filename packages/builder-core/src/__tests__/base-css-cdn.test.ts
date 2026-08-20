import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { renderThemeLayout, type SectionRenderer } from '../theme/theme-render';
import {
  assetHash,
  writeAssetManifest,
  safeAssetContentType,
  ALLOWED_ASSET_CONTENT_TYPES,
} from '../theme/assets';
import type { ThemeFiles } from '../theme/bundle';

// OFCE-701 Phase 3/4: the shared base stylesheet is promoted to a content-hashed asset at publish and
// CDN-linked (cached once cross-tenant) instead of inlined on every page; preview/local (no manifest
// entry) fall back to inlining it.
const LAYOUT =
  '<!doctype html><html><head>' +
  '{% if base_css_url != blank %}<link rel="stylesheet" href="{{ base_css_url }}">{% else %}<style>{{ base_css }}</style>{% endif %}' +
  '</head><body>{{ content_for_layout }}</body></html>';
const BASE = '.probe{color:#abcabc}';
const ctx = { content_for_layout: 'X', token_css: '' } as never;
const renderTrusted: SectionRenderer = (liquid, data) => render(liquid, data, { trusted: true });

test('a promoted base.css is CDN-linked by its hash, not inlined', async () => {
  const bytes = new TextEncoder().encode(BASE);
  const hash = assetHash(bytes);
  let files: ThemeFiles = { 'layout/theme.liquid': LAYOUT, 'assets/base.css': BASE };
  files = writeAssetManifest(files, {
    'assets/base.css': { hash, contentType: 'text/css', size: bytes.byteLength },
  });
  const html = await renderThemeLayout(files, renderTrusted, ctx);
  assert.ok(
    html.includes(`<link rel="stylesheet" href="/assets/${hash}">`),
    'links the hashed base asset'
  );
  assert.ok(!html.includes('<style>.probe'), 'does not also inline the base');
});

test('without a manifest entry, base.css falls back to inline (preview/local)', async () => {
  const files: ThemeFiles = { 'layout/theme.liquid': LAYOUT, 'assets/base.css': BASE };
  const html = await renderThemeLayout(files, renderTrusted, ctx);
  assert.ok(html.includes('<style>.probe{color:#abcabc}</style>'), 'inlines the base');
  assert.ok(!html.includes('<link rel="stylesheet"'), 'no link when unpromoted');
});

test('text/css is allowlisted (base can be CDN-served) but html/js/svg stay neutralized', () => {
  assert.ok(ALLOWED_ASSET_CONTENT_TYPES.has('text/css'));
  assert.equal(safeAssetContentType('text/css'), 'text/css');
  assert.equal(safeAssetContentType('text/html'), 'application/octet-stream');
  assert.equal(safeAssetContentType('application/javascript'), 'application/octet-stream');
  assert.equal(safeAssetContentType('image/svg+xml'), 'application/octet-stream');
});
