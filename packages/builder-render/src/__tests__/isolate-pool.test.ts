// OFCE-614 — the untrusted-render worker POOL. Proves: warm workers are reused across renders (no
// per-render spawn), and a runaway that trips the wall-clock kill is terminated AND replaced so the
// pool keeps serving (co-tenant safety must not regress). Timing gains are measured separately by
// bench/speed-spike.ts; here we assert the behavioural contract only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderUntrusted,
  RenderTimeout,
  RenderFailed,
  __renderPoolStats,
  __shutdownRenderPool,
  __setWorkerFactoryForTest,
} from '@ratio/builder-render/isolate';

after(async () => {
  await __shutdownRenderPool();
});

test('warm workers are reused — sequential renders do not each spawn a worker', async () => {
  await __shutdownRenderPool();
  const tpl = '{{ p.title | escape }}';

  assert.equal(await renderUntrusted(tpl, { p: { title: 'one' } }), 'one');
  const afterFirst = __renderPoolStats();
  assert.equal(afterFirst.live, 1, 'one worker spawned');
  assert.equal(afterFirst.idle, 1, 'returned to the pool idle, not terminated');

  // Five more sequential renders must reuse that idle worker — everSpawned stays put.
  for (let i = 0; i < 5; i++) {
    assert.equal(await renderUntrusted(tpl, { p: { title: 't' + i } }), 't' + i);
  }
  assert.equal(
    __renderPoolStats().everSpawned,
    afterFirst.everSpawned,
    'no new workers spawned — the warm worker was reused every time'
  );
});

test('a runaway is killed by the wall-clock and its worker is replaced — the pool keeps serving', async () => {
  await __shutdownRenderPool();
  const tpl = '{{ p.title | escape }}';

  // A runaway (renderLimit/wall-clock will stop it) fired alongside legit renders.
  const runaway = renderUntrusted(
    '{% for i in (1..100000000) %}{{ i }}{% endfor %}',
    {},
    { timeoutMs: 120 }
  );
  const legits = Array.from({ length: 6 }, (_, i) =>
    renderUntrusted(tpl, { p: { title: 'x' + i } })
  );

  const settled = await Promise.allSettled([runaway, ...legits]);

  // The runaway is rejected (timeout kill or the cooperative engine limit) — never hangs.
  assert.equal(settled[0].status, 'rejected');
  assert.ok(
    (settled[0] as PromiseRejectedResult).reason instanceof RenderTimeout ||
      (settled[0] as PromiseRejectedResult).reason instanceof RenderFailed
  );
  // Every legit peer still rendered correctly.
  for (let i = 0; i < 6; i++) {
    const r = settled[i + 1];
    assert.equal(r.status, 'fulfilled');
    assert.equal((r as PromiseFulfilledResult<string>).value, 'x' + i);
  }

  // The pool self-healed: a render after the kill still works (the terminated worker was replaced).
  assert.equal(await renderUntrusted(tpl, { p: { title: 'after' } }), 'after');
});

test('a worker that fails to construct rejects the render cleanly — no hang, no crash', async () => {
  await __shutdownRenderPool();
  // Simulate resource exhaustion (EMFILE/ENOMEM): worker construction throws synchronously. The pool
  // must degrade to "fail this render" (RenderFailed), never a synchronous throw in a timer/event
  // callback (which would crash the origin) and never a waiter that hangs forever.
  __setWorkerFactoryForTest(() => {
    throw new Error('EMFILE: too many open files');
  });
  try {
    await assert.rejects(
      () => renderUntrusted('{{ x }}', { x: 1 }),
      (e: unknown) => e instanceof RenderFailed
    );
  } finally {
    __setWorkerFactoryForTest(null);
  }
  // And the pool recovers once construction works again.
  await __shutdownRenderPool();
  assert.equal(await renderUntrusted('{{ p.title }}', { p: { title: 'ok' } }), 'ok');
});
