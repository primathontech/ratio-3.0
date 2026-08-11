// OFCE-491 · edge-render PoC — step 1: measure the AST-walk render CPU of the REAL trusted
// pipeline (composePage → registry → LiquidJS) on a synthesized worst-case page. This runs the
// same render code the origin uses; the only Workers delta is the compile-cache key in
// engine.ts (node:crypto → a non-crypto hash / WebCrypto), noted in the report.
//
// Run: node --import tsx poc/edge-render/measure.ts [sections] [productsPerGrid] [iters]

import { composePage } from '@ratio/builder-core';
import { defaultRegistry } from '@ratio/builder-registry';
import type { PageDoc } from '@ratio/builder-core';

const SECTIONS = Number(process.argv[2] ?? 25); // Shopify caps a template at 25 sections
const PRODUCTS = Number(process.argv[3] ?? 50); // 50 products per grid = heavy PLP
const ITERS = Number(process.argv[4] ?? 200);

function product(i: number) {
  return {
    handle: `product-${i}`,
    title: `Product ${i} — a reasonably long merchandising title`,
    image_url: `https://cdn.example.com/img/${i}.jpg`,
    price: 49900 + i * 100, // paise
    compare_at_price: 79900,
    variant_id: 1000 + i,
  };
}

// Worst-case page: alternating hero + productGrid, each grid loaded with PRODUCTS items. The Liquid
// `{% for p in grid.products %}` loop is where the render CPU actually goes.
function worstCasePage(): PageDoc {
  const products = Array.from({ length: PRODUCTS }, (_, i) => product(i));
  const sections = Array.from({ length: SECTIONS }, (_, i) => {
    if (i % 3 === 0) {
      return {
        id: `hero-${i}`,
        type: 'hero',
        version: 1,
        data: {
          hero: {
            heading: `Section ${i}`,
            sub: 'A subheading for the hero band',
            cta: { label: 'Shop now', href: '/collections/all' },
          },
        },
      };
    }
    return {
      id: `grid-${i}`,
      type: 'productGrid',
      version: 1,
      data: { grid: { heading: `Bestsellers ${i}`, products } },
    };
  });
  return { path: '/', title: 'Worst-case home', sections };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const registry = defaultRegistry();
  const doc = worstCasePage();

  // Warm up: first render compiles + caches templates (compile-once). Steady-state render is what
  // the edge pays on a cache MISS, so measure post-warmup.
  const warm = await composePage(doc, registry);
  const grids = doc.sections.filter((s) => s.type === 'productGrid').length;

  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await composePage(doc, registry);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);

  console.log('OFCE-491 · worst-case render CPU (real pipeline, post-warmup)');
  console.log('─'.repeat(60));
  console.log(
    `sections: ${SECTIONS}  (grids ${grids} × ${PRODUCTS} products = ${grids * PRODUCTS} product renders)`
  );
  console.log(
    `output:   ${(warm.html.length / 1024).toFixed(1)} KB  ·  tier: ${warm.tier}  ·  cacheable: ${warm.cacheable}`
  );
  console.log(`iters:    ${ITERS}`);
  console.log('─'.repeat(60));
  console.log(`median:   ${percentile(samples, 50).toFixed(2)} ms`);
  console.log(`p95:      ${percentile(samples, 95).toFixed(2)} ms`);
  console.log(`p99:      ${percentile(samples, 99).toFixed(2)} ms`);
  console.log(`max:      ${samples[samples.length - 1].toFixed(2)} ms`);
  console.log('─'.repeat(60));
  console.log('PASS threshold (OFCE-491): median render CPU well under the 30s Paid cap;');
  console.log('single-digit→low-tens of ms = comfortably fits the edge (I/O wait is free).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
