// base ⊕ overrides (LLD Bucket E): a store's theme is an immutable base + the merchant's overrides
// (only their changed files). composeTheme flattens the two into the full theme the compiler renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTheme, diffFromBase, DELETES_MANIFEST } from '../theme/theme-compose';
import type { ThemeFiles } from '../theme/bundle';

test('override replaces a base file; a new override adds; untouched base files pass through', () => {
  const base: ThemeFiles = { 'a.liquid': 'BASE-A', 'b.liquid': 'BASE-B' };
  const overrides: ThemeFiles = { 'a.liquid': 'MINE-A', 'c.liquid': 'MINE-C' };
  assert.deepEqual(composeTheme(base, overrides), {
    'a.liquid': 'MINE-A', // override wins
    'b.liquid': 'BASE-B', // untouched base file tracks the base
    'c.liquid': 'MINE-C', // added by the merchant
  });
});

test('a path listed in _deletes is removed, and the manifest is not itself a theme file', () => {
  const base: ThemeFiles = { 'a.liquid': 'A', 'b.liquid': 'B' };
  const overrides: ThemeFiles = { [DELETES_MANIFEST]: JSON.stringify(['b.liquid']) };
  const out = composeTheme(base, overrides);
  assert.deepEqual(out, { 'a.liquid': 'A' });
  assert.ok(
    !(DELETES_MANIFEST in out),
    'the deletes manifest is control data, never a rendered file'
  );
});

test('an override of a deleted path re-adds it (override wins over the delete)', () => {
  const base: ThemeFiles = { 'a.liquid': 'BASE' };
  const overrides: ThemeFiles = {
    'a.liquid': 'MINE',
    [DELETES_MANIFEST]: JSON.stringify(['a.liquid']),
  };
  assert.deepEqual(composeTheme(base, overrides), { 'a.liquid': 'MINE' });
});

test('empty overrides → the base unchanged', () => {
  const base: ThemeFiles = { 'a.liquid': 'A' };
  assert.deepEqual(composeTheme(base, {}), { 'a.liquid': 'A' });
});

test('a malformed _deletes manifest is ignored (no crash, no accidental deletes)', () => {
  const base: ThemeFiles = { 'a.liquid': 'A' };
  const overrides: ThemeFiles = { [DELETES_MANIFEST]: 'not json' };
  assert.deepEqual(composeTheme(base, overrides), { 'a.liquid': 'A' });
});

test('diffFromBase stores only the delta: changed + added files, and a _deletes for removed', () => {
  const base: ThemeFiles = { 'a.liquid': 'A', 'b.liquid': 'B', 'c.liquid': 'C' };
  // Merchant kept a as-is, changed b, added d, removed c.
  const full: ThemeFiles = { 'a.liquid': 'A', 'b.liquid': 'MINE-B', 'd.liquid': 'D' };
  assert.deepEqual(diffFromBase(base, full), {
    'b.liquid': 'MINE-B', // changed vs base
    'd.liquid': 'D', // added
    [DELETES_MANIFEST]: JSON.stringify(['c.liquid']), // removed base file
    // 'a.liquid' is NOT stored — it tracks the base
  });
});

test('diffFromBase is the inverse of composeTheme (round-trips any full tree)', () => {
  const base: ThemeFiles = { 'a.liquid': 'A', 'b.liquid': 'B' };
  for (const full of [
    { 'a.liquid': 'A', 'b.liquid': 'B' }, // identical → empty overrides
    { 'a.liquid': 'MINE', 'b.liquid': 'B', 'x.liquid': 'X' }, // change + add
    { 'a.liquid': 'A' }, // delete b
    {}, // delete all
  ] as ThemeFiles[]) {
    assert.deepEqual(composeTheme(base, diffFromBase(base, full)), full);
  }
});

test('diffFromBase of an identical tree stores nothing (pure base adoption)', () => {
  const base: ThemeFiles = { 'a.liquid': 'A', 'b.liquid': 'B' };
  assert.deepEqual(diffFromBase(base, { ...base }), {});
});
