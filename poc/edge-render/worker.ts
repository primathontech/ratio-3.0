// OFCE-491 · edge-render PoC on workerd (real Workers V8). nodejs_compat is OFF.
//
// Since the edge-render-core split (#148) this imports the REAL render pipeline through clean
// package entries — `@ratio/builder-core/edge` (composePage, no pg store) + `@ratio/builder-registry`
// (edge-safe, untrusted isolate injected only on Node). No reaching into src/, no eslint-disable.
import { composePage } from '@ratio/builder-core/edge';
import { defaultRegistry } from '@ratio/builder-registry';
import { worstCasePage } from './worst-case';

const registry = defaultRegistry();

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sections = Number(url.searchParams.get('sections') ?? 25);
    const products = Number(url.searchParams.get('products') ?? 50);
    const iters = Number(url.searchParams.get('iters') ?? 50);

    const doc = worstCasePage(sections, products);
    const warm = await composePage(doc, registry); // warmup: compile + cache templates

    const samples: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t = performance.now();
      await composePage(doc, registry);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const pct = (q: number) =>
      samples[Math.min(samples.length - 1, Math.floor((q / 100) * samples.length))];

    const body = {
      runtime: 'workerd (Cloudflare Workers V8)',
      nodejs_compat: false,
      note: 'real composePage via @ratio/builder-core/edge (no pg, no worker_threads)',
      sections,
      products,
      productRenders: doc.sections.filter((s) => s.type === 'productGrid').length * products,
      outputKB: +(warm.html.length / 1024).toFixed(1),
      tier: warm.tier,
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
