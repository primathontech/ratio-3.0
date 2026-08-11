import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { SpanStatusCode } from '@opentelemetry/api';
import { withSpan, withRequestSpan, initTracing, SpanKind } from '../index';

// OTel registers ONE global provider per process — register once, reset the exporter between tests.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
before(() => provider.register());
after(() => provider.shutdown());

test('withSpan records a span with attrs, kind + OK status (SDK works under tsx)', async () => {
  exporter.reset();
  const out = await withSpan(
    'gokwik.cart.add',
    { 'ratio.reqId': 'r1' },
    async () => 42,
    SpanKind.CLIENT
  );
  assert.equal(out, 42);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.name, 'gokwik.cart.add');
  assert.equal(span.attributes['ratio.reqId'], 'r1');
  assert.equal(span.kind, SpanKind.CLIENT);
  assert.equal(span.status.code, SpanStatusCode.OK);
});

test('withSpan marks ERROR + records the exception TYPE only (no raw message/PII) and rethrows', async () => {
  exporter.reset();
  await assert.rejects(
    withSpan('gokwik.cart.add', {}, async () => {
      throw new Error('secret sk_live_ABC in message');
    })
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  const ex = span.events.find((e) => e.name === 'exception');
  assert.ok(ex, 'an exception event is recorded (shows in SigNoz)');
  assert.equal(ex!.attributes?.['exception.type'], 'Error');
  const safe = JSON.stringify({ events: span.events, status: span.status, attrs: span.attributes });
  assert.ok(!safe.includes('sk_live'), 'raw error message never on the span');
});

test('child span nests under withRequestSpan across await; kinds are SERVER/CLIENT', async () => {
  exporter.reset();
  await withRequestSpan('origin.request', {}, {}, async () => {
    await withSpan('gokwik.cart.add', {}, async () => 1, SpanKind.CLIENT);
  });
  const spans = exporter.getFinishedSpans();
  const parent = spans.find((s) => s.name === 'origin.request')!;
  const child = spans.find((s) => s.name === 'gokwik.cart.add')!;
  assert.equal(parent.kind, SpanKind.SERVER);
  assert.equal(child.kind, SpanKind.CLIENT);
  assert.equal(
    child.parentSpanContext?.spanId,
    parent.spanContext().spanId,
    'child nests under request'
  );
});

test('initTracing is null without an endpoint (off by default)', () => {
  assert.equal(initTracing({ service: 'origin' }), null);
});
