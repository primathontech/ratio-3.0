// OFCE-491 · edge-render PoC on workerd (real Workers V8). nodejs_compat is OFF.
//
// FINDING: the render CORE is edge-clean, but the package BARRELS are not — importing
// `@ratio/builder-core` drags in `pg` (Postgres driver → pgpass → split2 → node:stream), and
// `@ratio/builder-render`'s barrel drags in the untrusted isolate (`node:worker_threads`). Neither
// belongs at the edge. So this worker imports ONLY the edge-safe render modules directly:
//   - engine.ts   (LiquidJS render; node:crypto already removed)
//   - sections.ts (the first-party section templates — plain strings)
// and runs a minimal trusted compose. Production fix = split an `edge-render-core` entry that
// excludes the DB store + the worker-thread isolate.
/* eslint-disable no-restricted-imports --
   PoC deliberately reaches into the edge-CLEAN render modules directly. Importing the package
   barrels (@ratio/builder-render / @ratio/builder-core) is what drags pg + node:worker_threads
   into the edge bundle — the very finding this PoC documents. Production fix = a real
   edge-render-core entry, after which these become normal @ratio/* imports. */
import { render } from '../../packages/builder-render/src/engine';
import { FIRST_PARTY_SECTIONS } from '../../packages/builder-render/src/sections';
/* eslint-enable no-restricted-imports */
import { worstCasePage } from './worst-case';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Minimal trusted compose: section templates rendered in order (the productGrid Liquid loop is the
// dominant cost, identical to composePage). Chrome is trivialized — we're measuring render CPU.
async function composeMinimal(doc: ReturnType<typeof worstCasePage>): Promise<string> {
  const parts: string[] = [];
  for (const s of doc.sections) {
    const def = FIRST_PARTY_SECTIONS[s.type];
    parts.push(await render(def.template, s.data as Record<string, unknown>, { trusted: true }));
  }
  return `<!doctype html><html><head><title>${esc(doc.title ?? '')}</title></head><body>${parts.join('\n')}</body></html>`;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sections = Number(url.searchParams.get('sections') ?? 25);
    const products = Number(url.searchParams.get('products') ?? 50);
    const iters = Number(url.searchParams.get('iters') ?? 50);

    const doc = worstCasePage(sections, products);
    const warm = await composeMinimal(doc); // warmup: compile + cache templates

    const samples: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t = performance.now();
      await composeMinimal(doc);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const pct = (q: number) =>
      samples[Math.min(samples.length - 1, Math.floor((q / 100) * samples.length))];

    const body = {
      runtime: 'workerd (Cloudflare Workers V8)',
      nodejs_compat: false,
      note: 'render core imported directly (barrels excluded: no pg, no worker_threads)',
      sections,
      products,
      productRenders: doc.sections.filter((s) => s.type === 'productGrid').length * products,
      outputKB: +(warm.length / 1024).toFixed(1),
      iters,
      median_ms: +pct(50).toFixed(2),
      p95_ms: +pct(95).toFixed(2),
      p99_ms: +pct(99).toFixed(2),
    };
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
