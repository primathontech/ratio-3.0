// Ratio content model (ADR-003/004). A page is an ordered list of typed sections.
// normalizePage() upgrades legacy {title,body,price} configs so old content still renders.

export interface ProductCard {
  title: string;
  price: string;
  image?: string;
  href: string;
}

export type Section =
  | { kind: 'hero'; heading: string; sub?: string; cta?: { label: string; href: string } }
  | { kind: 'richText'; html: string }
  | { kind: 'productGrid'; heading?: string; products: ProductCard[] }
  | { kind: 'product'; title: string; price: string; image?: string; description?: string };

export interface PageConfig {
  title?: string;
  sections: Section[];
}

// Accepts a real PageConfig ({sections:[...]}) or a legacy {title,body,price} blob.
export function normalizePage(raw: unknown): PageConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (Array.isArray(r.sections)) {
    return { title: r.title as string | undefined, sections: r.sections as Section[] };
  }
  const sections: Section[] = [];
  const title = typeof r.title === 'string' ? r.title : undefined;
  const body = typeof r.body === 'string' ? r.body : undefined;
  const price = r.price != null ? String(r.price) : undefined;

  if (price) {
    sections.push({ kind: 'product', title: title ?? '', price, description: body });
  } else if (title) {
    sections.push({ kind: 'hero', heading: title, sub: body });
  } else if (body) {
    sections.push({ kind: 'richText', html: body });
  }
  if (sections.length === 0) sections.push({ kind: 'richText', html: '' });
  return { title, sections };
}
