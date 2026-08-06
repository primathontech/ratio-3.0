// Self-contained render worker (plain ESM — loads identically under the tsx dev runner and plain
// node in prod, no TS loader needed). It rebuilds a sandboxed Liquid engine from the limits +
// filter allowlist passed in as workerData, renders, and posts back {ok, html} | {ok:false, error}.
// The parent (isolate.ts) enforces the wall-clock kill by terminating this worker on timeout.
//
// Kept dependency-light on PURPOSE: importing the .ts engine here would drag the TS loader into the
// worker. The engine's limits/allowlist are the source of truth and are passed in as data.

import { parentPort, workerData } from 'node:worker_threads';
import { Liquid } from 'liquidjs';

function buildEngine({ limits, allowlist }) {
  const engine = new Liquid({
    strictFilters: true,
    strictVariables: false,
    renderLimit: limits.renderLimit,
    memoryLimit: limits.memoryLimit,
    parseLimit: limits.parseLimit,
    dynamicPartials: false,
  });
  engine.registerFilter('money', (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? '₹' + n.toFixed(2) : '';
  });
  // untrusted: strip every filter not on the allowlist so strictFilters rejects it.
  const registered = engine.filters;
  if (registered && typeof registered.forEach === 'function') {
    const remove = [];
    registered.forEach((_v, name) => {
      if (!(name in allowlist)) remove.push(name);
    });
    for (const name of remove) registered.delete(name);
  }
  return engine;
}

async function run() {
  const { source, data, limits, allowlist } = workerData;
  try {
    const engine = buildEngine({ limits, allowlist });
    const html = await engine.parseAndRender(source, data);
    parentPort?.postMessage({ ok: true, html });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

void run();
