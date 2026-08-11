import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logEvent } from '../log';

// Capture what the logger writes to stdout (console.log is the sink).
function capture(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    out.push(String(s));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

test('logEvent emits one structured JSON line with the level + event fields', () => {
  const lines = capture(() =>
    logEvent('info', { evt: 'cart_add', tenant: 't1', ok: false, variant: 'v9', lines: 0 })
  );
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.lvl, 'info');
  assert.equal(rec.evt, 'cart_add');
  assert.equal(rec.tenant, 't1');
  assert.equal(rec.lines, 0); // the diagnostic datum for the empty-cart bug
});

test('logEvent carries ONLY the allowlisted fields — no room for a token/cookie/secret', () => {
  const [line] = capture(() =>
    logEvent('error', { evt: 'commerce_error', tenant: 't1', op: 'checkout', err: 'boom' })
  );
  const rec = JSON.parse(line);
  assert.deepEqual(Object.keys(rec).sort(), ['err', 'evt', 'lvl', 'op', 'tenant']);
});
