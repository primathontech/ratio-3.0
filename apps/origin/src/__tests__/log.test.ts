import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger,
  requestLog,
  logCartAdd,
  logCartUpdate,
  logCommerceError,
  classifyError,
} from '../log';

// Capture pino output via an injectable destination stream — no monkeypatching a global console.
function capture() {
  const lines: string[] = [];
  const log = createLogger({ write: (s: string) => lines.push(s) });
  return { log, records: () => lines.map((l) => JSON.parse(l)) };
}

test('cart_add: structured line carries the reqId, a timestamp, and warns when nothing was added', () => {
  const c = capture();
  logCartAdd(requestLog(c.log, 'req-1'), { tenant: 't1', ok: false, variant: 'v9', lines: 0 });
  const [r] = c.records();
  assert.equal(r.evt, 'cart_add');
  assert.equal(r.reqId, 'req-1'); // correlation id — group all events for one request
  assert.equal(r.tenant, 't1');
  assert.equal(r.lines, 0); // the diagnostic datum
  assert.equal(r.lvl, 'warn'); // ok:false routes to warn
  assert.equal(r.svc, 'origin');
  assert.ok(typeof r.time === 'number', 'has an event timestamp');
});

test('cart_update is instrumented too (not silently swallowed)', () => {
  const c = capture();
  logCartUpdate(requestLog(c.log, 'r'), { tenant: 't1', ok: true, variant: 'v1' });
  assert.equal(c.records()[0].evt, 'cart_update');
});

test('commerce_error logs a CLOSED taxonomy code + errType — NEVER the raw backend message', () => {
  const c = capture();
  // A backend error whose message carries a secret + a credentialed URL (the exact leak risk).
  const leaky = new Error('auth failed for key sk_live_ABC123 at https://api?token=SEKRIT');
  logCommerceError(requestLog(c.log, 'r'), 'add', 't1', leaky);
  const [r] = c.records();
  assert.equal(r.evt, 'commerce_error');
  assert.equal(r.op, 'add');
  assert.equal(r.code, 'backend_error');
  assert.equal(r.errType, 'Error');
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('sk_live'), 'the secret-bearing message is never logged');
  assert.ok(!dump.includes('SEKRIT'));
});

test('classifyError maps network + timeout codes to a stable taxonomy', () => {
  assert.equal(
    classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code,
    'network'
  );
  assert.equal(
    classifyError(Object.assign(new Error('x'), { name: 'AbortError' })).code,
    'timeout'
  );
  assert.equal(classifyError(new Error('cart data missing')).code, 'empty_response');
});
