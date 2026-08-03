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
  timeoutMs?: number; // wall-clock kill (default 250ms — well above a legit render, well below a hang)
}

// Render UNTRUSTED source in an isolated worker. Resolves to HTML, or throws RenderTimeout /
// RenderFailed. Every untrusted merchant/app template render goes through here.
export function renderUntrusted(
  source: string,
  data: Record<string, unknown>,
  opts?: IsolateOptions
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 250;

  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { source, data, limits: UNTRUSTED_LIMITS, allowlist: FILTER_ALLOWLIST },
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
