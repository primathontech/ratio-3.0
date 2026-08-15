// Storefront chrome (header + footer) rendered from the THEME so a merchant can edit it in the code
// editor, while the ORIGIN still renders it into the shell of EVERY page (home, collection, product,
// cart, order) so the whole storefront shares one header/footer.
//
// The menu/footer are DATA from the commerce backend; we map them to sanitized link trees here (hrefs
// via navHref → only http(s)/relative can reach an href) and hand those to the theme's
// sections/header.liquid + sections/footer.liquid as `menu` / `footer`. The section Liquid does the
// markup — merchants own it. A theme that carries no header/footer section (older themes, the bare
// base) falls back to the built-in renderHeader/renderFooter so the header never disappears.
import type { ThemeFiles } from './bundle';
import { renderHeader, navHref, type NavMenu, type NavItem } from './nav';
import { renderFooter, type FooterMenu } from './footer';

const HEADER_PATH = 'sections/header.liquid';
const FOOTER_PATH = 'sections/footer.liquid';

// A sanitized link the theme Liquid iterates: title + a safe href, an `external` flag for target/rel,
// optional children, and `grouped` (a child that itself has children → an accordion column).
export interface ChromeLink {
  title: string;
  href: string;
  external: boolean;
  items?: ChromeLink[];
  grouped?: boolean;
}

const isExternal = (href: string) => /^https?:\/\//i.test(href);

function toLink(item: NavItem): ChromeLink {
  const href = navHref(item); // the ONE sanitizing transform (safeUrl inside)
  const kids = (item.items ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(toLink);
  const link: ChromeLink = { title: item.title, href, external: isExternal(href) };
  if (kids.length) {
    link.items = kids;
    link.grouped = kids.some((k) => (k.items?.length ?? 0) > 0);
  }
  return link;
}

// The top-level link tree for the header/footer, sorted by the backend's position, hrefs sanitized.
export function chromeLinks(menu: NavMenu | FooterMenu | null): ChromeLink[] {
  return (menu?.items ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(toLink);
}

export type ChromeRenderer = (liquid: string, data: Record<string, unknown>) => Promise<string>;

// Render the header + footer for a page. Uses the theme's own header/footer section when present
// (rendered untrusted, via the injected renderer — keeps this file edge-safe), else the built-in
// chrome. `render` is the same untrusted Liquid renderer the origin uses for theme sections.
export async function renderChrome(
  compiled: ThemeFiles,
  render: ChromeRenderer,
  opts: { menu: NavMenu | null; footer: FooterMenu | null; siteName: string }
): Promise<{ header: string; footer: string }> {
  const siteName = opts.siteName || 'Store';
  const headerLiquid = compiled[HEADER_PATH];
  const footerLiquid = compiled[FOOTER_PATH];
  const [header, footer] = await Promise.all([
    headerLiquid != null
      ? render(headerLiquid, { site_name: siteName, menu: chromeLinks(opts.menu) })
      : Promise.resolve(renderHeader({ menu: opts.menu, siteName })),
    footerLiquid != null
      ? render(footerLiquid, { site_name: siteName, footer: chromeLinks(opts.footer) })
      : Promise.resolve(renderFooter({ footer: opts.footer, siteName })),
  ]);
  return { header, footer };
}
