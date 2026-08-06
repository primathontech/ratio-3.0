// Hard-isolation wrapper for untrusted rendering (D40). Runs a render in a worker thread with a
// wall-clock timeout; if the template blows the timeout (infinite loop, pathological expansion
// that slips past renderLimit), the worker is TERMINATED — it can never starve the origin's main
// event loop that serves reserved paths for every other tenant. This is the enforcement the
// cooperative engine limits (engine.ts) cannot guarantee alone.

import { Worker } from 'node:worker_threads';
import { UNTRUSTED_LIMITS, FILTER_ALLOWLIST } from './engine';

export class RenderTimeout extends Error {}
export class RenderFailed extends Error {}

// Plain-.mjs worker → loads identically under the dev tsx runner and prod node (no TS loader).
const WORKER = new URL('./worker.mjs', import.meta.url);

export interface IsolateOptions {
  // Wall-clock kill. NB: the budget currently includes worker-thread cold-start (a fresh worker is
  // spawned per render), which varies a lot on a cold/loaded runner — so the default is generous
  // enough to cover spin-up + a legit render, yet far below a real hang. The engine's cooperative
  // render/memory limits catch runaway templates well before this backstop fires.
  // TODO: pool workers + start the timer on a ready-handshake to restore a tight render-only budget.
  timeoutMs?: number;
}

// Render UNTRUSTED source in an isolated worker. Resolves to HTML, or throws RenderTimeout /
// RenderFailed. Every untrusted merchant/app template render goes through here.
export function renderUntrusted(
  source: string,
  data: Record<string, unknown>,
  opts?: IsolateOptions
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 2000;

  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { source, data, limits: UNTRUSTED_LIMITS, allowlist: FILTER_ALLOWLIST },
      // The worker is a self-contained .mjs — it needs no loader. Start it with a clean execArgv so
      // it never inherits the parent's --import preloads (the tsx loader, a test bootstrap): this is
      // an isolation boundary, and those preloads only add attack surface + startup cost here.
      execArgv: [],
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        done(() => reject(new RenderTimeout(`render exceeded ${timeoutMs}ms — worker terminated`))),
      timeoutMs
    );
    worker.on('message', (m: { ok: boolean; html?: string; error?: string }) =>
      done(() =>
        m.ok ? resolve(m.html ?? '') : reject(new RenderFailed(m.error ?? 'render failed'))
      )
    );
    worker.on('error', (e: Error) => done(() => reject(new RenderFailed(e.message))));
    worker.on('exit', (code) => {
      if (code !== 0) done(() => reject(new RenderFailed('worker exited ' + code)));
    });
  });
}
