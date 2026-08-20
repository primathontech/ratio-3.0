// SEO <head> tags for the storefront (OFCE-718). Injected into the platform-owned content_for_header
// slot so every theme gets them for free. This first slice covers the page-level essentials that need
// no entity data: a CANONICAL link (the clean path, no query — so faceted/sorted/paginated variants
// don't split ranking), a robots noindex for those query-string variants, and core Open Graph/Twitter.
// Entity-specific meta (title, description, image, Product/Breadcrumb JSON-LD) layers on per page type
// in a later slice. Every interpolated value is attribute-escaped — url/siteName are untrusted-ish.
import { canonicalPath } from '../page-builder/path';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SeoHeadInput {
  url: string; // the full request URL (absolute) — origin + path + query
  siteName: string; // the store's display name
}

// The canonical URL is the request origin + the NORMALIZED path with the query dropped. Using
// canonicalPath (the same normalizer routing/cache-tags use — collapses //, strips trailing /, NFC)
// means /c/shoes, /c/shoes/, /c/shoes?sort=price and /c/shoes?page=2 all converge on ONE canonical.
export function seoHead({ url, siteName }: SeoHeadInput): string {
  const u = new URL(url);
  const canonical = `${u.origin}${canonicalPath(u.pathname)}`;
  const tags: string[] = [];
  // Query-string variants (facets/sort/pagination) are near-duplicate content — keep them out of the
  // index but still let crawlers follow links from them.
  if (u.search.length > 0) tags.push('<meta name="robots" content="noindex,follow">');
  tags.push(`<link rel="canonical" href="${esc(canonical)}">`);
  tags.push(`<meta property="og:site_name" content="${esc(siteName)}">`);
  tags.push(`<meta property="og:url" content="${esc(canonical)}">`);
  tags.push('<meta property="og:type" content="website">');
  tags.push('<meta name="twitter:card" content="summary_large_image">');
  return tags.join('');
}
