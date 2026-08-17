// Storefront footer. Like the header, the footer menu is DATA from the commerce backend (the same
// nav-menus API, footer-menu handle) — fetched canonical, mapped to links only at render
// (consumer-driven). The footer chrome itself is OURS (rendered into the shell by composePage). A
// tenant with no footer menu → a minimal footer (the legal line only), never a crash.

import { type NavMenu, type NavItem, navHref } from './nav';

// The footer menu shares the backend nav-menu shape (link columns). Kept as an alias so the type
// can diverge later without touching callers, once the real footer API response is known.
export type FooterMenu = NavMenu;

// Returned when the live footer API can't be reached (down, unconfigured, or a merchant with no
// footer menu). For now it is an EMPTY menu — the footer renders its legal line only. Replace
// footer-fallback.json with the real saved response once available (same as the header's fallback).
import fallbackFooter from './footer-fallback.json';
export const FALLBACK_FOOTER = fallbackFooter as FooterMenu;

// Fetch the merchant's footer menu. On any failure (no base url, non-200 like a merchant with no
// footer, or a network error) it returns FALLBACK_FOOTER so the footer always renders. Returns the
// backend shape UNCHANGED (link mapping happens at render).
export async function fetchFooter(
  merchantId: string,
  footerApiBaseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<FooterMenu> {
  if (!footerApiBaseUrl || !merchantId) return FALLBACK_FOOTER;
  try {
    const res = await fetchImpl(
      `${footerApiBaseUrl.replace(/\/+$/, '')}/api/v1/storefront/nav-menus/footer-menu`,
      {
        headers: { 'gk-merchant-id': merchantId },
      }
    );
    if (!res.ok) return FALLBACK_FOOTER;
    const data = (await res.json()) as FooterMenu;
    return data && Array.isArray(data.items) ? data : FALLBACK_FOOTER;
  } catch {
    return FALLBACK_FOOTER;
  }
}

const esc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const external = (href: string) =>
  /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';

function link(item: NavItem, cls: string): string {
  const href = navHref(item);
  return `<a class="${cls}" href="${esc(href)}"${external(href)}>${esc(item.title)}</a>`;
}

// A footer column: a heading (the top-level item) + its child links; a top-level item with no
// children renders as a single link.
function column(item: NavItem): string {
  const kids = item.items ?? [];
  if (!kids.length) return `<div class="ftr-col">${link(item, 'ftr-col-h')}</div>`;
  const links = kids.map((k) => `<li>${link(k, '')}</li>`).join('');
  return `<div class="ftr-col">${link(item, 'ftr-col-h')}<ul>${links}</ul></div>`;
}

// The footer chrome: link columns (when a menu exists) + a legal line. No menu → legal line only
// (still a real footer, never blank/broken).
export function renderFooter(opts: { footer: FooterMenu | null; siteName: string }): string {
  const items = (opts.footer?.items ?? []).slice().sort((a, b) => a.position - b.position);
  const cols = items.length ? `<div class="ftr-cols">${items.map(column).join('')}</div>` : '';
  const legal = `<div class="ftr-legal">© ${esc(opts.siteName || 'Store')} · powered by Ratio</div>`;
  return `<footer class="ftr"><div class="rt ftr-in">${cols}${legal}</div></footer>`;
}
