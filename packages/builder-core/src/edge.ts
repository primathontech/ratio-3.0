// Edge-safe entry for @ratio/builder-core — the render + data-binding surface with NO Node deps in
// its graph (no `pg` page store, no worker-thread isolate). This is what a Cloudflare Worker imports
// (`@ratio/builder-core/edge`); the Node origin keeps using the main barrel. Together with the
// edge-safe @ratio/builder-render barrel + the injected untrusted renderer, the whole render path
// runs on Workers unchanged.
export { composePage, type ComposedPage } from './page-builder/compose';
export {
  resolvePage,
  interpolateParams,
  StubResolver,
  type BindingResolver,
  type ResolveContext,
  type ResolvedSource,
  type TenantCommerce,
} from './commerce/resolve';
export {
  renderHeader,
  navHref,
  fetchMainMenu,
  FALLBACK_MENU,
  type NavMenu,
  type NavItem,
} from './storefront/nav';
export { renderFooter, fetchFooter, FALLBACK_FOOTER, type FooterMenu } from './storefront/footer';
export { storefrontHead, type ThemeTokens } from './storefront/storefront';
export * from './page-builder/doc';
