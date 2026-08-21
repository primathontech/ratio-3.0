import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SW_REGISTER_SNIPPET,
  SW_REGISTER_TAG,
  SW_SCRIPT_HASH,
  SW_CSP,
  DEFAULT_SERVICE_WORKER,
} from '../theme/service-worker';

test('SW_SCRIPT_HASH is the sha256 of the exact registration snippet (CSP will match it)', () => {
  const expected = `'sha256-${createHash('sha256').update(SW_REGISTER_SNIPPET).digest('base64')}'`;
  assert.equal(SW_SCRIPT_HASH, expected);
});

test('SW_REGISTER_TAG wraps exactly the snippet (bytes the CSP hash covers)', () => {
  assert.equal(SW_REGISTER_TAG, `<script>${SW_REGISTER_SNIPPET}</script>`);
  assert.match(SW_REGISTER_SNIPPET, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
});

test('SW_CSP authorizes only the snippet (by hash) + the same-origin worker', () => {
  assert.deepEqual(SW_CSP['script-src'], [SW_SCRIPT_HASH]);
  assert.deepEqual(SW_CSP['worker-src'], ["'self'"]);
  // no 'self'/'unsafe-inline' on script-src — only the exact hash may run
  assert.ok(!SW_CSP['script-src'].includes("'self'"));
  assert.ok(!SW_CSP['script-src'].includes("'unsafe-inline'"));
});

test('DEFAULT_SERVICE_WORKER: a conservative worker — fetch handler, network-first HTML, cache-first assets', () => {
  assert.match(
    DEFAULT_SERVICE_WORKER,
    /addEventListener\('fetch'/,
    'has a fetch handler (installable)'
  );
  assert.match(DEFAULT_SERVICE_WORKER, /skipWaiting/, 'takes over promptly');
  assert.match(DEFAULT_SERVICE_WORKER, /clients\.claim/);
  // immutable hashed assets are cache-first; everything else (HTML) is network-first
  assert.match(DEFAULT_SERVICE_WORKER, /\/assets\//, 'special-cases immutable assets');
  assert.match(DEFAULT_SERVICE_WORKER, /fetch\(r\)\.then/, 'network-first for pages');
  // same-origin GET only — never touches cross-origin or mutations
  assert.match(DEFAULT_SERVICE_WORKER, /r\.method!=='GET'/);
  assert.match(DEFAULT_SERVICE_WORKER, /u\.origin!==location\.origin/);
});
