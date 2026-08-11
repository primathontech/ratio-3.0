import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { app } from '../index';

// Prove the origin's tracing wiring end-to-end: with a provider registered, a request through the
// middleware emits an `origin.request` span carrying the reqId. (/health needs no DB or edge-auth.)
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
before(() => provider.register());
after(() => provider.shutdown());

test('every origin request emits an origin.request span carrying the reqId', async () => {
  exporter.reset();
  await app.fetch(new Request('http://origin/health', { headers: { 'x-request-id': 'rid-9' } }));
  const span = exporter.getFinishedSpans().find((s) => s.name === 'origin.request');
  assert.ok(span, 'origin.request span emitted');
  assert.equal(span!.attributes['ratio.reqId'], 'rid-9');
});
