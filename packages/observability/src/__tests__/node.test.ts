import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, requestLog } from '../index';

// Capture pino output via an injectable destination stream — no monkeypatching a global.
function capture() {
  const lines: string[] = [];
  const log = createLogger({ service: 'origin', dest: { write: (s: string) => lines.push(s) } });
  return { log, records: () => lines.map((l) => JSON.parse(l)) };
}

test('node logger: svc + lvl + time, reqId via requestLog, redaction backstop', () => {
  const c = capture();
  requestLog(c.log, 'req-1').warn({ evt: 'cart_add', tenant: 't1', token: 'SEKRIT' });
  const [r] = c.records();
  assert.equal(r.svc, 'origin');
  assert.equal(r.lvl, 'warn');
  assert.equal(r.reqId, 'req-1');
  assert.ok(typeof r.time === 'number');
  assert.equal(r.token, '[redacted]', 'a stray secret key is scrubbed');
});

test('re-exports the shared core (classifyError) so callers have one import surface', async () => {
  const { classifyError } = await import('../index');
  assert.equal(
    classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code,
    'network'
  );
});

test('log lines carry trace_id/span_id when inside an active span (logs↔traces correlation)', async () => {
  const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
  const { trace } = await import('@opentelemetry/api');
  const provider = new NodeTracerProvider();
  provider.register();
  try {
    const c = capture();
    await trace.getTracer('t').startActiveSpan('s', async (span) => {
      c.log.info({ evt: 'x' });
      span.end();
    });
    const [r] = c.records();
    assert.ok(r.trace_id, 'trace_id stamped when in a span');
    assert.ok(r.span_id, 'span_id stamped');
  } finally {
    await provider.shutdown();
  }
});
