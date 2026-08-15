import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemeTokens, resolveThemeTokens, TOKENS_PATH } from '../theme-tokens';

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

test('resolveThemeTokens lets the theme win, tenant theme fills the gaps', () => {
  const compiled = { [TOKENS_PATH]: JSON.stringify({ color: '#111827', radius: 'square' }) };
  const tenant = { color: '#dc2626', bodyFont: 'serif', container: 'wide' };
  // theme overrides color + radius; tenant supplies bodyFont + container it didn't set.
  assert.deepEqual(resolveThemeTokens(compiled, tenant), {
    color: '#111827',
    radius: 'square',
    bodyFont: 'serif',
    container: 'wide',
  });
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
