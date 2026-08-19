import type { ThemeFiles } from './bundle';
import { DEFAULT_THEME_FILES } from './default-theme.generated';

// The starter theme a brand-new store adopts (base ⊕ overrides). A real, editable e-commerce home —
// hero, promo posters, two product rows bound to collections (New Arrivals / Trending), and a brand
// story — plus collection + product pages, and an editable header + footer. Every merchant edits THIS.
//
// Header/footer are theme sections (sections/header.liquid, sections/footer.liquid) the merchant can
// edit, but they are NOT listed in any page template: the ORIGIN renders them (renderChrome) into the
// shell of EVERY page — home, collection, product, cart, order — from the store's real name + nav, so
// the whole storefront shares one header/footer. The sanitized menu/footer link tree arrives as the
// `menu` / `footer` context (each item: title, href, external, items, grouped).
//
// Render contract (theme-render.ts): the theme owns the WHOLE document (OFCE-630). `layout/theme.liquid`
// is a full <!doctype html> page — its <head> owns the title, the design-system CSS (assets/base.css,
// inlined as {{ base_css }}), the brand-token overrides ({{ token_css }}), and the merchant's own CSS
// ({{ theme_css }}); its <body> owns the header/footer chrome ({{ header }}/{{ footer }}) and the composed
// sections ({{ content_for_layout }}). The ORIGIN injects only {{ content_for_header }} (islands runtime,
// integration head, security) and {{ content_for_body_end }} (integration body scripts). Each
// `templates/<page>.json` lists section instances; a section `type` resolves to `sections/<type>.liquid`.
// Sections use the platform CSS classes (.rt/.hdr/.hero/.grid/.card/.slideshow/.pdp/.ftr, shipped in
// assets/base.css) so they look styled out of the box and follow the merchant's brand colour/font.
//
// Data: collection/product templates + the home's two product rows declare `dataSources` and bind a
// section via `dataSourceKey`; the resolver injects the fetched data FLAT into the bound section's
// Liquid context (COLLECTION_BY_HANDLES → { products }, PRODUCT → a flat product). A merchant changes
// which collection a row shows by editing its handle, then Publish → live. Only allowlisted Liquid
// filters (money, escape, default) — a store's Liquid is treated as untrusted.
export function defaultBundleTheme(): ThemeFiles {
  return { ...DEFAULT_THEME_FILES };
}
