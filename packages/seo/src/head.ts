// The v3 adaptation of storefront-2.0's meta-tags generator: instead of returning a Next.js `Metadata`
// object, it renders the <head> tags as an HTML string for the origin to inject into the theme's
// platform-owned content_for_header slot. Every interpolated value is attribute-escaped; JSON-LD is
// emitted with `<` escaped so an entity field can't break out of the <script>.
import { escAttr, jsonLdScript } from './escape';
import { isFilteredUrl, metaText } from './extract';

export interface SeoHeadInput {
  url: string; // raw request URL (absolute) — used only to detect facet/sort/pagination params
  canonicalUrl: string; // the absolute canonical URL (caller normalizes the path)
  siteName: string; // the store's display name
  title?: string; // entity/page name (e.g. the product) — drives og:title
  description?: string; // raw (maybe HTML) description → stripped + truncated meta description
  imageUrl?: string; // absolute image URL → og:image / twitter:image
  type?: 'website' | 'product'; // og:type (default 'website')
  jsonLd?: unknown | unknown[]; // one or many schema.org objects → a <script> each (null items skipped)
}

export function renderSeoHead({
  url,
  canonicalUrl,
  siteName,
  title,
  description,
  imageUrl,
  type,
  jsonLd,
}: SeoHeadInput): string {
  const tags: string[] = [];
  // Facet/sort/pagination variants are near-duplicate content — keep them out of the index but still
  // let crawlers follow links from them. A malformed url just means "no facet params" — renderSeoHead
  // must never throw (it backs the origin's must-not-500 SEO guarantee).
  let search = '';
  try {
    search = new URL(url).search;
  } catch {
    // leave search empty
  }
  if (isFilteredUrl(search)) tags.push('<meta name="robots" content="noindex,follow">');
  tags.push(`<link rel="canonical" href="${escAttr(canonicalUrl)}">`);
  tags.push(`<meta property="og:site_name" content="${escAttr(siteName)}">`);
  tags.push(`<meta property="og:url" content="${escAttr(canonicalUrl)}">`);
  tags.push(`<meta property="og:type" content="${escAttr(type ?? 'website')}">`);
  if (title) tags.push(`<meta property="og:title" content="${escAttr(title)}">`);
  if (description) {
    const d = metaText(description);
    if (d) {
      tags.push(`<meta name="description" content="${escAttr(d)}">`);
      tags.push(`<meta property="og:description" content="${escAttr(d)}">`);
    }
  }
  tags.push('<meta name="twitter:card" content="summary_large_image">');
  if (imageUrl) {
    tags.push(`<meta property="og:image" content="${escAttr(imageUrl)}">`);
    tags.push(`<meta name="twitter:image" content="${escAttr(imageUrl)}">`);
  }
  if (jsonLd != null) {
    for (const item of Array.isArray(jsonLd) ? jsonLd : [jsonLd]) {
      if (item != null) tags.push(jsonLdScript(item));
    }
  }
  return tags.join('');
}
