import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, requestLog } from '../core';
import { createLogger as createNodeLogger } from '../node';
import { createLogger as createEdgeLogger } from '../edge';

// ── core ──────────────────────────────────────────────────────────────────────
test('classifyError → closed taxonomy + type name, never the raw message', () => {
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), {
    code: 'network',
    errType: 'Error',
  });
  assert.equal(
    classifyError(Object.assign(new Error('x'), { name: 'AbortError' })).code,
    'timeout'
  );
  const leaky = classifyError(new Error('auth failed key sk_live_ABC at https://x?token=SEKRIT'));
  assert.equal(leaky.code, 'error');
  assert.ok(!JSON.stringify(leaky).includes('sk_live'), 'raw message never surfaces');
});

// ── node (pino) ───────────────────────────────────────────────────────────────
function nodeCapture() {
  const lines: string[] = [];
  const log = createNodeLogger({
    service: 'origin',
    dest: { write: (s: string) => lines.push(s) },
  });
  return { log, records: () => lines.map((l) => JSON.parse(l)) };
}

test('node logger: svc + lvl + time, reqId via requestLog, redaction backstop', () => {
  const c = nodeCapture();
  requestLog(c.log, 'req-1').warn({ evt: 'cart_add', tenant: 't1', token: 'SEKRIT' });
  const [r] = c.records();
  assert.equal(r.svc, 'origin');
  assert.equal(r.lvl, 'warn');
  assert.equal(r.reqId, 'req-1');
  assert.ok(typeof r.time === 'number');
  assert.equal(r.token, '[redacted]', 'a stray secret key is scrubbed');
});

// ── edge (Workers-safe) ─────────────────────────────────────────────────────────
function edgeCapture() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => lines.push(String(s));
  return { restore: () => (console.log = orig), records: () => lines.map((l) => JSON.parse(l)) };
}

test('edge logger: same shape as node, level filtering, no pino', () => {
  const cap = edgeCapture();
  try {
    const log = createEdgeLogger({ service: 'edge', level: 'warn' });
    log.info({ evt: 'access' }); // below threshold → dropped
    requestLog(log, 'r9').error({ evt: 'access', status: 500, cookie: 'SEKRIT' });
    const recs = cap.records();
    assert.equal(recs.length, 1, 'info was filtered by the warn threshold');
    const [r] = recs;
    assert.equal(r.svc, 'edge');
    assert.equal(r.lvl, 'error');
    assert.equal(r.reqId, 'r9');
    assert.equal(r.status, 500);
    assert.equal(r.cookie, '[redacted]');
  } finally {
    cap.restore();
  }
});
