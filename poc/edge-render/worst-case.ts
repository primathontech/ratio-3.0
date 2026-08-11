// Shared worst-case page generator for the OFCE-491 harness (Node) + worker (workerd).
import type { PageDoc } from '@ratio/builder-core';

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

// Alternating hero + productGrid; each grid loaded with `products` items. The Liquid
// `{% for p in grid.products %}` loop is where the render CPU actually goes.
export function worstCasePage(sections = 25, products = 50): PageDoc {
  const items = Array.from({ length: products }, (_, i) => product(i));
  const list = Array.from({ length: sections }, (_, i) => {
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
      data: { grid: { heading: `Bestsellers ${i}`, products: items } },
    };
  });
  return { path: '/', title: 'Worst-case home', sections: list };
}
