import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@ratio/observability';
import { requestLog, logCartAdd, logCartUpdate, logCommerceError } from '../log';

// Foundation (logger, correlation, taxonomy, redaction) is tested in @ratio/observability. Here we
// only test the origin's DOMAIN events, capturing via an injectable pino stream (no monkeypatching).
function capture() {
  const lines: string[] = [];
  const log = createLogger({ service: 'origin', dest: { write: (s: string) => lines.push(s) } });
  return { log, records: () => lines.map((l) => JSON.parse(l)) };
}

test('cart_add: carries reqId + fields, warns when nothing was added', () => {
  const c = capture();
  logCartAdd(requestLog(c.log, 'req-1'), { tenant: 't1', ok: false, variant: 'v9', lines: 0 });
  const [r] = c.records();
  assert.equal(r.evt, 'cart_add');
  assert.equal(r.reqId, 'req-1');
  assert.equal(r.lines, 0);
  assert.equal(r.lvl, 'warn');
});

test('cart_update is instrumented (not silently swallowed)', () => {
  const c = capture();
  logCartUpdate(requestLog(c.log, 'r'), { tenant: 't1', ok: true, variant: 'v1' });
  assert.equal(c.records()[0].evt, 'cart_update');
});

test('commerce_error: closed taxonomy code + type — NEVER the raw backend message', () => {
  const c = capture();
  const leaky = new Error('auth failed for key sk_live_ABC123 at https://api?token=SEKRIT');
  logCommerceError(requestLog(c.log, 'r'), 'add', 't1', leaky);
  const [r] = c.records();
  assert.equal(r.evt, 'commerce_error');
  assert.equal(r.op, 'add');
  assert.equal(r.code, 'error');
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('sk_live') && !dump.includes('SEKRIT'), 'secret never logged');
});
