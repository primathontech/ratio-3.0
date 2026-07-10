// The edge->origin URL join must not double-slash when ORIGIN_URL has a trailing "/".
import { test } from 'node:test';
import assert from 'node:assert';
import { originTarget } from '../apps/edge/worker';

test('joins base + path without a double slash (trailing slash on base)', () => {
  assert.strictEqual(
    originTarget('https://x.awsapprunner.com/', '/', ''),
    'https://x.awsapprunner.com/'
  );
  assert.strictEqual(
    originTarget('https://x.awsapprunner.com', '/', ''),
    'https://x.awsapprunner.com/'
  );
});

test('preserves path + query', () => {
  assert.strictEqual(
    originTarget('https://x.com/', '/products/red', '?store=t_acme'),
    'https://x.com/products/red?store=t_acme'
  );
});
