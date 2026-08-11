import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { SpanStatusCode } from '@opentelemetry/api';
import { withSpan, initTracing } from '../index';

// OTel registers ONE global provider per process — register once, reset the exporter between tests.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
before(() => provider.register());
after(() => provider.shutdown());

test('withSpan records a span with attrs + OK status (SDK works under tsx)', async () => {
  exporter.reset();
  const out = await withSpan(
    'cart.add',
    { 'ratio.reqId': 'r1', 'ratio.op': 'add' },
    async () => 42
  );
  assert.equal(out, 42);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.name, 'cart.add');
  assert.equal(span.attributes['ratio.reqId'], 'r1');
  assert.equal(span.status.code, SpanStatusCode.OK);
});

test('withSpan marks ERROR (type only, no raw message) and rethrows', async () => {
  exporter.reset();
  await assert.rejects(
    withSpan('cart.add', {}, async () => {
      throw new Error('secret sk_live_ABC in message');
    })
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.ok(
    !(span.status.message ?? '').includes('sk_live'),
    'raw error message never on the span'
  );
});

test('initTracing is a no-op without an endpoint (off by default)', () => {
  assert.equal(initTracing({ service: 'origin' }), false);
});
