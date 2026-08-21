import { NOINDEX_SEARCH_PARAM } from './constants';
import type { ProductLike, ProductSeoFields } from './types';

// Meta descriptions want plain text, ~160 chars — a product description is often long HTML. Strip tags,
// collapse whitespace, truncate on a whole-string boundary with an ellipsis.
export function metaText(s: string, max = 160): string {
  const t = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Pull SEO fields out of a canonical product, mirroring the storefront-2.0 extractor + render transform:
// title/description honour the merchant SEO override chain (seo_title → seo.title → title); price is
// variants[0].price.amount with the top-level product.price fallback (both paise); images are every
// absolute http(s) url (image_url + images[].url|src + image.url), is_main first, deduped.
export function extractProductSeo(p: ProductLike): ProductSeoFields {
  const title = p.seo_title || p.seo?.title || p.title || p.name || undefined;
  const description = p.seo_description || p.seo?.description || p.description || undefined;

  const imgs = Array.isArray(p.images) ? p.images : [];
  const mainImg = imgs.find((i) => i?.is_main);
  const candidates = [
    mainImg?.url ?? mainImg?.src,
    p.image_url,
    ...imgs.map((i) => i?.url ?? i?.src),
    p.image?.url,
  ];
  const images = Array.from(
    new Set(candidates.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)))
  );

  const variantAmount = Array.isArray(p.variants) ? p.variants[0]?.price?.amount : undefined;
  const priceMinor =
    typeof variantAmount === 'number'
      ? variantAmount
      : typeof p.price === 'number'
        ? p.price
        : undefined;

  return {
    title,
    description,
    images,
    priceMinor,
    currency: p.currency,
    available: p.available,
    sku: p.sku,
    brand: p.brand,
    gtin: p.gtin || p.barcode,
  };
}

// True when a URL's query has any facet/sort/pagination param — those variants are near-duplicate
// content and should be noindexed (the canonical still consolidates them).
export function isFilteredUrl(search: string | URLSearchParams): boolean {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  for (const key of params.keys()) if (NOINDEX_SEARCH_PARAM.test(key)) return true;
  return false;
}
