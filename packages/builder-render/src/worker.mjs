// Self-contained render worker (plain ESM — loads identically under the tsx dev runner and plain
// node in prod, no TS loader needed). It rebuilds a sandboxed Liquid engine ONCE from the limits +
// filter allowlist passed in as workerData, signals `{ready:true}`, then serves render requests off
// a message loop: each `{source, data}` → `{ok, html}` | `{ok:false, error}`. Pooled + reused across
// renders (OFCE-614) so a render pays no worker cold-start; the parent (isolate.ts) still enforces
// the wall-clock kill by TERMINATING this worker on timeout (and replacing it in the pool).
//
// Kept dependency-light on PURPOSE: importing the .ts engine here would drag the TS loader into the
// worker. The engine's limits/allowlist are the source of truth and are passed in as data.
//
// Reuse is safe: parseAndRender is stateless per call (it parses `source` and renders against `data`
// each time), the engine holds only constant config + the fixed filter allowlist, and untrusted
// Liquid cannot execute JS to leave residue — so one warm engine serves every render. The pool
// dispatches ONE render per worker at a time, so renders never interleave on the shared engine.

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
  // MUST match engine.ts money exactly: the backend returns prices in PAISE, so paise→rupees is /100.
  // (This worker is a hand-written second engine copy — a drift here shows every price 100× wrong on
  // storefront sections, which render through this isolate. Guarded by an engine↔isolate parity test.)
  engine.registerFilter('money', (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? '₹' + (n / 100).toFixed(2) : '';
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

const engine = buildEngine(workerData);

parentPort?.on('message', async (msg) => {
  try {
    const html = await engine.parseAndRender(msg.source, msg.data);
    parentPort.postMessage({ ok: true, html });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Ready-handshake: the engine is built and the message loop is attached — the pool may now dispatch.
parentPort?.postMessage({ ready: true });
