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
}
export interface NavMenu {
  handle: string;
  title: string;
  items: NavItem[];
  version?: number;
}

// Fetch the merchant's main menu. Null on any non-200 / error (e.g. a merchant with no menu 404s) —
// the caller renders the fallback header. Returns the backend shape UNCHANGED (mapping is at render).
export async function fetchMainMenu(
  merchantId: string,
  navApiBaseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<NavMenu | null> {
  try {
    const res = await fetchImpl(`${navApiBaseUrl.replace(/\/+$/, '')}/nav-menus/main-menu`, {
      headers: { 'gk-merchant-id': merchantId },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NavMenu;
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
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
function column(item: NavItem): string {
  const kids = item.items ?? [];
  if (!kids.length) return `<div class="hdr-col">${link(item, 'hdr-col-h')}</div>`;
  const links = kids.map((k) => `<li>${link(k, '')}</li>`).join('');
  return `<div class="hdr-col">${link(item, 'hdr-col-h')}<ul>${links}</ul></div>`;
}

function topItem(item: NavItem): string {
  const kids = item.items ?? [];
  if (!kids.length) return link(item, 'hdr-link');
  return (
    `<div class="hdr-item">${link(item, 'hdr-link')}` +
    `<div class="hdr-mega"><div class="hdr-cols">${kids.map(column).join('')}</div></div></div>`
  );
}

// The header chrome: brand + nav. No menu → brand only (still a real header, never blank/broken).
export function renderHeader(opts: { menu: NavMenu | null; siteName: string }): string {
  const brand = `<a class="hdr-brand" href="/">${esc(opts.siteName || 'Store')}</a>`;
  const items = (opts.menu?.items ?? []).slice().sort((a, b) => a.position - b.position);
  const nav = items.length ? `<nav class="hdr-nav">${items.map(topItem).join('')}</nav>` : '';
  return `<header class="hdr"><div class="rt hdr-in">${brand}${nav}</div></header>`;
}
