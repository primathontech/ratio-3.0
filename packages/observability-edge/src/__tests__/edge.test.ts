import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, requestLog } from '../index';

// Workers use console.log as the sink (no injectable stream), so capture it here only.
function capture() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => lines.push(String(s));
  return { restore: () => (console.log = orig), records: () => lines.map((l) => JSON.parse(l)) };
}

test('edge logger: same shape as node (lvl/svc/time/reqId), level filtering, redaction', () => {
  const cap = capture();
  try {
    const log = createLogger({ service: 'edge', level: 'warn' });
    log.info({ evt: 'access' }); // below the warn threshold → dropped
    requestLog(log, 'r9').error({ evt: 'access', status: 500, cookie: 'SEKRIT' });
    const recs = cap.records();
    assert.equal(recs.length, 1, 'info was filtered by the warn threshold');
    const [r] = recs;
    assert.equal(r.svc, 'edge');
    assert.equal(r.lvl, 'error');
    assert.equal(r.reqId, 'r9');
    assert.equal(r.status, 500);
    assert.ok(typeof r.time === 'number');
    assert.equal(r.cookie, '[redacted]');
  } finally {
    cap.restore();
  }
});
