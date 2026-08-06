// Storefront navigation (header menu). The menu is DATA from the commerce backend (gokwik
// nav-menus API) — fetched canonical, mapped to links only at render (consumer-driven). The header
// itself is OURS (chrome, rendered into the shell by composePage). A tenant with no menu → a
// minimal fallback header (brand only), never a crash.

// The backend's shape (GET /nav-menus/main-menu, header gk-merchant-id). Kept as-is.
export interface NavItem {
  id: string;
  title: string;
  position: number;
  depth: number;
  resource_type: string; // COLLECTION | PRODUCT | PAGE | HTTP | ...
  resource_id: string | null;
  external_url: string | null;
  relative_path: string | null;
  url: string; // COLLECTION → collection handle; HTTP → external url
  items?: NavItem[];
  image?: string | null;
  show_image?: boolean;
  mega_menu_enabled?: boolean;
}
export interface NavMenu {
  handle: string;
  title: string;
  items: NavItem[];
  version?: number;
  is_default?: boolean;
  items_count?: number;
}

// Returned when the live nav API can't be reached (down, unconfigured, or a merchant with no menu),
// so the header still renders a full menu instead of falling back to brand-only. Stored as JSON.
import fallbackMenu from './nav-fallback.json';
export const FALLBACK_MENU = fallbackMenu as NavMenu;

// Fetch the merchant's main menu. On any failure (no base url, non-200 like a merchant with no
// menu, or a network error) it returns FALLBACK_MENU so the header always has a menu. Returns the
// backend shape UNCHANGED (link mapping happens at render).
export async function fetchMainMenu(
  merchantId: string,
  navApiBaseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<NavMenu> {
  if (!navApiBaseUrl || !merchantId) return FALLBACK_MENU;
  try {
    const res = await fetchImpl(
      `${navApiBaseUrl.replace(/\/+$/, '')}/api/v1/storefront/nav-menus/main-menu`,
      {
        headers: { 'gk-merchant-id': merchantId },
      }
    );
    if (!res.ok) return FALLBACK_MENU;
    const data = (await res.json()) as NavMenu;
    return data && Array.isArray(data.items) ? data : FALLBACK_MENU;
  } catch {
    return FALLBACK_MENU;
  }
}

const esc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Only http(s) or site-relative links may reach an href — a javascript:/data: url in backend data
// can never execute from the menu.
function safeUrl(u: string | null | undefined): string {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|\/)/i.test(s) ? s : '#';
}

// Map a menu item to a storefront href — the ONE transform, done at render. COLLECTION/PRODUCT/PAGE
// become our internal routes; HTTP is an external link; anything else falls back to relative_path.
export function navHref(item: NavItem): string {
  switch (item.resource_type) {
    case 'COLLECTION':
      return item.url ? `/collections/${encodeURIComponent(item.url)}` : '/';
    case 'PRODUCT':
      return item.url ? `/products/${encodeURIComponent(item.url)}` : '/';
    case 'PAGE':
      return item.url ? `/pages/${encodeURIComponent(item.url)}` : '/';
    case 'HTTP':
      return safeUrl(item.external_url ?? item.url);
    default:
      return safeUrl(item.relative_path ?? (item.url ? `/${item.url}` : '/'));
  }
}

const external = (href: string) =>
  /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';

function link(item: NavItem, cls: string): string {
  const href = navHref(item);
  return `<a class="${cls}" href="${esc(href)}"${external(href)}>${esc(item.title)}</a>`;
}

// A depth-1 entry in a mega menu: either a column header with its depth-2 links, or a plain link.
// A leaf entry in a simple dropdown list (Product, Salon, Hair Styling, Hair Colour).
function listItem(item: NavItem): string {
  return `<li>${link(item, 'hdr-drop-link')}</li>`;
}

// An accordion group in a grouped dropdown (Hair Care): a native <details> (no JS — the storefront
// ships none) whose summary is the group title and whose body is the child links. A group with no
// children of its own collapses to a plain link.
function accordionGroup(item: NavItem): string {
  const kids = item.items ?? [];
  if (!kids.length)
    return `<a class="hdr-acc-h hdr-acc-solo" href="${esc(navHref(item))}">${esc(item.title)}</a>`;
  const links = kids.map((k) => `<li>${link(k, 'hdr-drop-link')}</li>`).join('');
  return `<details class="hdr-acc"><summary class="hdr-acc-h">${esc(item.title)}</summary><ul class="hdr-acc-list">${links}</ul></details>`;
}

// A top-level nav entry. No children → a plain link. Leaf children → a simple list dropdown.
// Grouped children (children that themselves have children) → an accordion dropdown.
function topItem(item: NavItem): string {
  const kids = (item.items ?? []).slice().sort((a, b) => a.position - b.position);
  if (!kids.length) return link(item, 'hdr-link');
  const grouped = kids.some((k) => (k.items ?? []).length);
  const body = grouped
    ? `<div class="hdr-drop hdr-drop-acc">${kids.map(accordionGroup).join('')}</div>`
    : `<div class="hdr-drop hdr-drop-list"><ul>${kids.map(listItem).join('')}</ul></div>`;
  return `<div class="hdr-item">${link(item, 'hdr-link hdr-caret')}${body}</div>`;
}

// Storefront chrome to the right of the nav: search + cart + account. Presentational — search
// submits to /search, cart/account link to the reserved paths; the badge is a static 0. Wiring
// those to real data is the app's job; this is the chrome the header always shows.
const ICON_SEARCH =
  '<svg class="hdr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>';
const ICON_CART =
  '<svg class="hdr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 12.2a1.6 1.6 0 0 0 1.6 1.3h8.2a1.6 1.6 0 0 0 1.6-1.3L22 7H6"/></svg>';
const ICON_USER =
  '<svg class="hdr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';

const HEADER_ACTIONS =
  '<div class="hdr-actions">' +
  '<form class="hdr-search" role="search" action="/search" method="get">' +
  ICON_SEARCH +
  '<input name="q" placeholder="Search products" aria-label="Search products">' +
  '</form>' +
  `<a class="hdr-action hdr-cart" href="/cart" aria-label="Cart">${ICON_CART}<span class="hdr-badge">0</span><span class="hdr-action-t">Cart</span></a>` +
  `<a class="hdr-action" href="/account" aria-label="Account">${ICON_USER}<span class="hdr-action-t">Account</span></a>` +
  '</div>';

// The header chrome: brand + nav + actions. No menu → brand + actions (still a real header).
export function renderHeader(opts: { menu: NavMenu | null; siteName: string }): string {
  const brand = `<a class="hdr-brand" href="/">${esc(opts.siteName || 'Store')}</a>`;
  const items = (opts.menu?.items ?? []).slice().sort((a, b) => a.position - b.position);
  const nav = items.length ? `<nav class="hdr-nav">${items.map(topItem).join('')}</nav>` : '';
  return `<header class="hdr"><div class="rt hdr-in">${brand}${nav}${HEADER_ACTIONS}</div></header>`;
}
