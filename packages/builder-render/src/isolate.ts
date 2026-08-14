// Hard-isolation wrapper for untrusted rendering (D40). Every untrusted merchant/app template render
// runs in a worker thread with a wall-clock timeout; if the template blows the timeout (infinite
// loop, pathological expansion that slips past renderLimit), the worker is TERMINATED — it can never
// starve the origin's main event loop that serves every other tenant. This is the enforcement the
// cooperative engine limits (engine.ts) cannot guarantee alone.
//
// Workers are POOLED and reused (OFCE-614): the ~27ms worker cold-start used to dominate a cache-MISS
// render (measured in OFCE-600), so a fresh spawn per render was the single biggest storefront-render
// cost. The pool keeps warm workers, dispatches ONE render per worker at a time, and starts the
// wall-clock timer only after a ready worker is in hand (render-only budget, not spawn+render). A
// worker that times out or errors is terminated AND removed from the pool (self-healing); a fresh one
// is spawned on demand — so co-tenant safety is preserved (a runaway can't poison a reused worker).
//
// Bounded concurrency tradeoff: the pool caps live workers, so N concurrent runaways can occupy N
// workers until each is killed — but the cooperative renderLimit (engine.ts, ~100ms) frees a stuck
// worker well before the wall-clock backstop, and per-store fair-use limits (LLD D7) bound how many
// renders one tenant triggers. This is the right trade vs. an unbounded spawn-per-render (itself a
// spawn-storm DoS vector).

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { UNTRUSTED_LIMITS, FILTER_ALLOWLIST } from './engine';

export class RenderTimeout extends Error {}
export class RenderFailed extends Error {}

// Plain-.mjs worker → loads identically under the dev tsx runner and prod node (no TS loader).
const WORKER = new URL('./worker.mjs', import.meta.url);

export interface IsolateOptions {
  // Wall-clock kill, now RENDER-ONLY: the timer starts once a warm worker is in hand, so it no longer
  // includes worker cold-start. Real renders are sub-millisecond; the generous default is a backstop
  // for a hang, caught first by the engine's cooperative render/memory limits.
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
// Cap live workers to available parallelism — enough to render a page's sections concurrently and
// absorb concurrent requests, without a spawn storm.
const MAX_WORKERS = Math.max(2, os.cpus().length - 1);

interface Job {
  resolve: (html: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Pooled {
  worker: Worker;
  ready: boolean;
  job: Job | null; // the in-flight render, or null when idle
  onReady: ((p: Pooled) => void) | null; // resolves the spawn promise on the ready-handshake
  onSpawnError: ((e: Error) => void) | null; // rejects the spawn promise on an error before ready
}

const all = new Set<Pooled>();
const idle: Pooled[] = [];
const waiters: ((p: Pooled) => void)[] = [];
let everSpawned = 0; // test/observability counter

function spawn(): Promise<Pooled> {
  everSpawned++;
  const worker = new Worker(WORKER, {
    workerData: { limits: UNTRUSTED_LIMITS, allowlist: FILTER_ALLOWLIST },
    // Self-contained .mjs — start it with a clean execArgv so it never inherits the parent's --import
    // preloads (tsx loader, test bootstrap): an isolation boundary, and those only add startup cost.
    execArgv: [],
  });
  const p: Pooled = { worker, ready: false, job: null, onReady: null, onSpawnError: null };
  all.add(p);

  worker.on('message', (m: { ready?: boolean; ok?: boolean; html?: string; error?: string }) => {
    if (m.ready) {
      p.ready = true;
      const cb = p.onReady;
      p.onReady = null;
      p.onSpawnError = null;
      cb?.(p);
      return;
    }
    const job = p.job;
    if (!job) return; // stray (e.g. a result racing a timeout that already terminated the worker)
    p.job = null;
    clearTimeout(job.timer);
    if (m.ok) job.resolve(m.html ?? '');
    else job.reject(new RenderFailed(m.error ?? 'render failed'));
    release(p);
  });
  worker.on('error', (e: Error) => failWorker(p, new RenderFailed(e.message)));
  worker.on('exit', (code) => {
    if (code !== 0) failWorker(p, new RenderFailed('worker exited ' + code));
  });

  return new Promise<Pooled>((resolve, reject) => {
    p.onReady = resolve;
    p.onSpawnError = reject;
  });
}

// A worker died (crash, non-zero exit) or was killed. Reject its in-flight render, drop it from the
// pool, and pull replacements for anyone waiting.
function failWorker(p: Pooled, err: Error): void {
  if (!p.ready && p.onSpawnError) {
    const cb = p.onSpawnError;
    p.onReady = null;
    p.onSpawnError = null;
    all.delete(p);
    cb(err);
    return;
  }
  const job = p.job;
  p.job = null;
  if (job) {
    clearTimeout(job.timer);
    job.reject(err);
  }
  destroy(p);
}

// Terminate a worker and remove it from the pool, then spawn replacements to serve any waiters.
function destroy(p: Pooled): void {
  all.delete(p);
  const i = idle.indexOf(p);
  if (i >= 0) idle.splice(i, 1);
  void p.worker.terminate();
  while (waiters.length > 0 && all.size < MAX_WORKERS) {
    const give = waiters.shift()!;
    spawn().then(give, () => {
      /* spawn failure: the caller's render rejects via its own path; drop the waiter */
    });
  }
}

function release(p: Pooled): void {
  const give = waiters.shift();
  if (give) {
    give(p); // straight to a waiting render — stays ref'd
  } else {
    p.worker.unref(); // idle: don't keep the process alive
    idle.push(p);
  }
}

function acquire(): Promise<Pooled> {
  const w = idle.pop();
  if (w) {
    w.worker.ref(); // busy again — hold the loop for the duration of the render
    return Promise.resolve(w);
  }
  if (all.size < MAX_WORKERS) return spawn(); // a spinning-up worker stays ref'd until idle
  return new Promise<Pooled>((resolve) => waiters.push(resolve));
}

// Render UNTRUSTED source in a pooled, isolated worker. Resolves to HTML, or throws RenderTimeout /
// RenderFailed. The wall-clock budget covers the render only (a warm worker is already in hand).
export async function renderUntrusted(
  source: string,
  data: Record<string, unknown>,
  opts?: IsolateOptions
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const p = await acquire();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (p.job) {
        p.job = null;
        // The worker is stuck mid-render — terminate + drop it (a reused worker must never carry a
        // runaway forward), then reject. destroy() spawns a replacement for any waiter.
        destroy(p);
        reject(new RenderTimeout(`render exceeded ${timeoutMs}ms — worker terminated`));
      }
    }, timeoutMs);
    p.job = { resolve, reject, timer };
    p.worker.postMessage({ source, data });
  });
}

// Test/introspection hooks. `__renderPoolStats` proves reuse (everSpawned stays flat across renders);
// `__shutdownRenderPool` terminates all workers so a test process exits cleanly.
export function __renderPoolStats(): { live: number; idle: number; everSpawned: number } {
  return { live: all.size, idle: idle.length, everSpawned };
}
export async function __shutdownRenderPool(): Promise<void> {
  const workers = [...all];
  all.clear();
  idle.length = 0;
  waiters.length = 0;
  await Promise.all(workers.map((p) => p.worker.terminate()));
}
