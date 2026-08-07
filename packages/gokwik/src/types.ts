// One shape every GoKwik storefront widget (side-cart, checkout, kwikpass, …) implements. The
// storefront (origin) never knows about a specific vendor — it composes the enabled integrations
// through this seam and merges the result into the page + CSP.

// CSP as directive → source-list, so contributions from several integrations union cleanly before
// serialization (a plain string would force fragile substring edits).
export type CspDirectives = Record<string, string[]>;

export interface IntegrationContext {
  env: Record<string, string | undefined>;
  merchantId: string; // the tenant's GoKwik mid (same value used at onboarding)
  page: string; // 'home' | 'product' | 'collection' | 'cart' | … — lets an integration scope itself
}

export interface StorefrontIntegration {
  name: string;
  // Off by default. An integration turns on only when its config is present (env + a merchant id),
  // so the strict no-JS storefront is the untouched default when nothing is configured.
  enabled(ctx: IntegrationContext): boolean;
  head?(ctx: IntegrationContext): string; // markup for <head> (e.g. a stylesheet link)
  bodyEnd?(ctx: IntegrationContext): string; // markup before </body> (e.g. the widget script + globals)
  csp?(ctx: IntegrationContext): CspDirectives; // hosts THIS integration needs
  // Set-Cookie values to append when the cart token is created/changed (e.g. a JS-readable token the
  // widget reads). Full Set-Cookie strings.
  cartTokenCookies?(token: string, ctx: IntegrationContext): string[];
}
