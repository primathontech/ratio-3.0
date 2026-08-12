// A theme "bundle" is the on-S3 form of a theme (LLD BC0/BC1): the source files packed into ONE
// compressed blob, content-addressed by a stable hash of the canonical contents — never one object
// per file. These are pure functions (gzip + sha256), no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBundle, unpackBundle, bundleId, type ThemeFiles } from '../bundle';

const theme: ThemeFiles = {
  'sections/hero.liquid': '<section>{{ hero.heading }}</section>',
  'templates/index.json': '{"sections":["hero"]}',
  'assets/theme.css': 'body{margin:0}',
};

test('packBundle → unpackBundle round-trips the files exactly', () => {
  const blob = packBundle(theme);
  assert.ok(Buffer.isBuffer(blob));
  assert.deepEqual(unpackBundle(blob), theme);
});

test('bundleId is stable and independent of key insertion order', () => {
  const reordered: ThemeFiles = {
    'assets/theme.css': theme['assets/theme.css'],
    'templates/index.json': theme['templates/index.json'],
    'sections/hero.liquid': theme['sections/hero.liquid'],
  };
  assert.equal(bundleId(reordered), bundleId(theme));
});

test('bundleId is a sha256 hex string', () => {
  assert.match(bundleId(theme), /^[0-9a-f]{64}$/);
});

test('bundleId changes when any file content changes', () => {
  const changed: ThemeFiles = { ...theme, 'assets/theme.css': 'body{margin:1px}' };
  assert.notEqual(bundleId(changed), bundleId(theme));
});

test('bundleId changes when a file is added or removed', () => {
  const added: ThemeFiles = { ...theme, 'snippets/card.liquid': '<div></div>' };
  assert.notEqual(bundleId(added), bundleId(theme));
  const fewer: ThemeFiles = { ...theme };
  delete fewer['assets/theme.css'];
  assert.notEqual(bundleId(fewer), bundleId(theme));
});

test('an empty theme round-trips and has a stable id', () => {
  const empty: ThemeFiles = {};
  assert.deepEqual(unpackBundle(packBundle(empty)), empty);
  assert.equal(bundleId(empty), bundleId({}));
});
