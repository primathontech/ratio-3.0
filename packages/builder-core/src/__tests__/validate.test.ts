// OFCE-654: the draft-save structural validator. Pure — no DB/S3. Rejects unambiguous corruption
// (malformed JSON, a bad asset manifest, a layout that dropped a platform slot) but never legitimate WIP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateThemeFiles } from '../theme/validate';

const OK_LAYOUT =
  '<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>';
const HASH = 'a'.repeat(64);

test('a well-formed theme has no issues', () => {
  assert.deepEqual(
    validateThemeFiles({
      'layout/theme.liquid': OK_LAYOUT,
      'templates/index.json': JSON.stringify({ sections: [] }),
      'config/assets.json': JSON.stringify({
        'logo.png': { hash: HASH, contentType: 'image/png', size: 12 },
      }),
      'sections/hero.liquid': '<h1>{{ x }}</h1>',
    }),
    []
  );
});

test('malformed JSON in any theme .json file is flagged', () => {
  const issues = validateThemeFiles({
    'templates/index.json': '{ "sections": [ }', // broken
    'config/tokens.json': 'not json at all',
  });
  assert.deepEqual(issues.map((i) => i.path).sort(), [
    'config/tokens.json',
    'templates/index.json',
  ]);
  assert.ok(issues.every((i) => /valid JSON/.test(i.error)));
});

test('a malformed asset-manifest entry is flagged (loader would silently drop it)', () => {
  const issues = validateThemeFiles({
    'layout/theme.liquid': OK_LAYOUT,
    'config/assets.json': JSON.stringify({
      'good.png': { hash: HASH, contentType: 'image/png', size: 1 },
      'bad.png': { hash: 'nothex', contentType: 'image/png' }, // bad hash + missing size
    }),
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, 'config/assets.json');
  assert.match(issues[0].error, /bad\.png.*malformed/);
});

test('a layout missing content_for_layout or content_for_header is flagged', () => {
  const noBody = validateThemeFiles({
    'layout/theme.liquid':
      '<!doctype html><html><head>{{ content_for_header }}</head><body></body></html>',
  });
  assert.deepEqual(noBody, [
    { path: 'layout/theme.liquid', error: 'must include {{ content_for_layout }}' },
  ]);

  const noHead = validateThemeFiles({
    'layout/theme.liquid': '<!doctype html><html><body>{{ content_for_layout }}</body></html>',
  });
  assert.deepEqual(noHead, [
    { path: 'layout/theme.liquid', error: 'must include {{ content_for_header }}' },
  ]);
});

test('the slot check tolerates whitespace trims and inner spacing', () => {
  assert.deepEqual(
    validateThemeFiles({
      'layout/theme.liquid': '{{-content_for_header-}}{{  content_for_layout  }}',
    }),
    []
  );
});

test('a theme with no layout override is not forced to have one (WIP-friendly)', () => {
  // Editing only a section must not demand the merchant also send a layout.
  assert.deepEqual(validateThemeFiles({ 'sections/hero.liquid': '<h1>hi</h1>' }), []);
});

test('an empty tree has no issues', () => {
  assert.deepEqual(validateThemeFiles({}), []);
});

test('a manifest that is valid JSON but not an object is flagged', () => {
  const asArray = validateThemeFiles({ 'config/assets.json': '[]' });
  assert.deepEqual(asArray, [
    { path: 'config/assets.json', error: 'must be a JSON object of asset entries' },
  ]);
  // A JSON scalar is the same shape error.
  assert.deepEqual(validateThemeFiles({ 'config/assets.json': '5' }), [
    { path: 'config/assets.json', error: 'must be a JSON object of asset entries' },
  ]);
  // `null` is valid JSON but means "no manifest" — not an error.
  assert.deepEqual(validateThemeFiles({ 'config/assets.json': 'null' }), []);
});

test('multiple simultaneous issues are all aggregated, not short-circuited', () => {
  const issues = validateThemeFiles({
    'templates/index.json': '{ broken', // invalid JSON
    'config/assets.json': JSON.stringify({ x: { hash: 'nothex' } }), // malformed entry
    'layout/theme.liquid': '<!doctype html><html><body></body></html>', // no slots
  });
  const paths = issues.map((i) => i.path).sort();
  assert.deepEqual(paths, [
    'config/assets.json',
    'layout/theme.liquid',
    'layout/theme.liquid',
    'templates/index.json',
  ]);
});
