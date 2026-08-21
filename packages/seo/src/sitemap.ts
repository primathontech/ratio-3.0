import { escXml } from './escape';
import type { SitemapEntry } from './types';

// robots.txt — allow crawling, keep the transactional/private + API routes out, and point crawlers at
// the store's sitemap. `origin` is the request origin (scheme + host) so it's correct on any domain.
export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /account',
    'Disallow: /api/',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

// sitemap.xml from site-relative paths OR full SitemapEntry records (path + optional lastmod/priority/
// changefreq). Entries are de-duplicated by path (first wins, order preserved) and joined to `origin`;
// every <loc> is XML-escaped. The caller gathers the entries so this stays pure + testable.
export function sitemapXml(origin: string, entries: Array<string | SitemapEntry>): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const e of entries) {
    const entry: SitemapEntry = typeof e === 'string' ? { path: e } : e;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const parts = [`<loc>${escXml(origin + entry.path)}</loc>`];
    if (entry.lastModified) parts.push(`<lastmod>${escXml(entry.lastModified)}</lastmod>`);
    if (entry.changeFrequency) parts.push(`<changefreq>${entry.changeFrequency}</changefreq>`);
    if (typeof entry.priority === 'number')
      parts.push(`<priority>${entry.priority.toFixed(1)}</priority>`);
    rows.push(`  <url>${parts.join('')}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}
