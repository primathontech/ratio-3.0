import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemeTokens, resolveThemeTokens, TOKENS_PATH } from '../theme/theme-tokens';

test('parseThemeTokens keeps only known string token keys', () => {
  const raw = JSON.stringify({
    color: '#0ea5e9',
    radius: 'rounded',
    baseSize: 42, // wrong type — dropped
    nonsense: 'ignored', // unknown key — dropped
  });
  assert.deepEqual(parseThemeTokens(raw), { color: '#0ea5e9', radius: 'rounded' });
});

test('parseThemeTokens returns {} for absent, malformed, or non-object input', () => {
  assert.deepEqual(parseThemeTokens(undefined), {});
  assert.deepEqual(parseThemeTokens(null), {});
  assert.deepEqual(parseThemeTokens('{not json'), {});
  assert.deepEqual(parseThemeTokens('"a string"'), {});
  assert.deepEqual(parseThemeTokens('[1,2,3]'), {});
});

test('resolveThemeTokens: the theme is the default, an explicit merchant token overrides it', () => {
  const compiled = { [TOKENS_PATH]: JSON.stringify({ color: '#111827', radius: 'square' }) };
  const tenant = { color: '#dc2626', bodyFont: 'serif', container: 'wide' };
  // The merchant explicitly set color/bodyFont/container → those win. radius is only in the theme
  // → the theme default applies. (OFCE-699: theme = default look, merchant override wins.)
  assert.deepEqual(resolveThemeTokens(compiled, tenant), {
    color: '#dc2626',
    radius: 'square',
    bodyFont: 'serif',
    container: 'wide',
  });
});

test("resolveThemeTokens: the theme's own accent applies when the store set no brand colour", () => {
  // The crux of OFCE-699 — adopting a theme gives THAT theme's signature accent, not a leftover
  // tenant colour, when the merchant never chose one.
  const nova = { [TOKENS_PATH]: JSON.stringify({ color: '#ff4a00', bodyFont: 'sans' }) };
  assert.deepEqual(resolveThemeTokens(nova, {}), { color: '#ff4a00', bodyFont: 'sans' });
  assert.deepEqual(resolveThemeTokens(nova, undefined), { color: '#ff4a00', bodyFont: 'sans' });
});

test('resolveThemeTokens: an empty/blank tenant value does not override the theme', () => {
  const theme = { [TOKENS_PATH]: JSON.stringify({ color: '#ff4a00' }) };
  // A tenant row that carries color:'' (or a blank) must not shadow the theme's accent.
  assert.deepEqual(resolveThemeTokens(theme, { color: '' }), { color: '#ff4a00' });
});

test('resolveThemeTokens falls back to the tenant theme when the file is absent or the bundle is null', () => {
  const tenant = { color: '#dc2626' };
  assert.deepEqual(resolveThemeTokens({}, tenant), tenant);
  assert.deepEqual(resolveThemeTokens(null, tenant), tenant);
  assert.deepEqual(resolveThemeTokens(undefined, tenant), tenant);
});

test('resolveThemeTokens tolerates a merchant-corrupted tokens file (falls back, never throws)', () => {
  const tenant = { color: '#dc2626' };
  const compiled = { [TOKENS_PATH]: '{ total garbage' };
  assert.deepEqual(resolveThemeTokens(compiled, tenant), tenant);
});
