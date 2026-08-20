import { type Context } from 'hono';
import {
  esc,
  PgPageStore,
  composePage,
  resolvePage,
  fetchMainMenu,
  fetchFooter,
  renderChrome,
  storefrontResolver,
  type ThemeTokens,
  resolveThemeTokens,
  canonicalPath,
  pageTag,
  tenantTag,
  matchRoute,
  type RouteMatch,
  ThemeStore,
  renderThemePage,
  renderThemeLayout,
  layoutOwnsDocument,
  tokenCss,
} from '@ratio/builder-core';
import { composeGokwik, mergeCsp, cspToString, type CspDirectives } from '@ratio/gokwik';
import { defaultRegistry, renderSection, islandPlaceholder } from '@ratio/builder-registry';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import type { Tenant } from '@ratio/data-repo';
import { logger } from '../log';
import {
  type Vars,
  timed,
  integrationContext,
  setStorefrontSecurity,
  bundlePageName,
  STOREFRONT_BASE_CSP,
} from './helpers';
import { type Stats } from './ops';

// An island page relaxes the strict no-JS CSP by exactly what the first-party runtime needs and no
// more: run the self-hosted script, and let it fetch the same-origin island endpoints.
const ISLANDS_CSP: CspDirectives = { 'script-src': ["'self'"], 'connect-src': ["'self'"] };

export type StorefrontDeps = {
  themeStore: ThemeStore | null;
  pageStore: PgPageStore;
  pbRegistry: ReturnType<typeof defaultRegistry>;
  resolver: ReturnType<typeof storefrontResolver>;
  islandsUrl: string;
  stats: Stats;
};

export async function renderStorefront(
  c: Context<Vars>,
  tenant: Tenant,
  tenantId: string,
  deps: StorefrontDeps
): Promise<Response> {
  const { themeStore, pageStore, pbRegistry, resolver, islandsUrl, stats } = deps;
  const path = new URL(c.req.url).pathname;

  // Bundle theme render (BC1): a store that has published a bundle theme renders from its compiled
  // bundle — theme (merchant Liquid) sections run in the isolate. Falls through to the legacy page
  // store when the store has no bundle theme, or the bundle has no template for this URL.
  if (themeStore && tenant.liveThemeId) {
    const canon = canonicalPath(path);
    const matched = matchRoute(canon);
    const page = bundlePageName(canon, matched);
    const merchantId = tenant.commerce?.merchantId ?? '';
    const navUrl = process.env.COMMERCE_NAV_API_URL ?? '';
    try {
      const compiled = await timed(c, 'bundle', () =>
        themeStore.loadLiveCompiled(tenantId as string)
      );
      if (compiled && compiled[`templates/${page}.json`] != null) {
        // Full theme ownership (OFCE-630/641): the theme's layout/theme.liquid owns the WHOLE document
        // (head + chrome + sections). The publish/activate/rollback full-document invariant + the base
        // rebase guarantee every LIVE theme is a full document, so there is no TS-shell fallback — a live
        // theme without a full-document layout is a BUG. It is thrown with a marker so the catch below
        // RETHROWS it (→ 500 + logged) instead of degrading: we must not silently serve a headless page,
        // a 404, or stale page-builder content for a store whose theme is broken.
        if (!layoutOwnsDocument(compiled['layout/theme.liquid']))
          throw Object.assign(
            new Error(
              `live theme for tenant '${tenantId}' is not a full document (layout/theme.liquid missing <!doctype/<html), v${tenant.liveThemeVersion ?? '?'}`
            ),
            { fullDocumentViolation: true }
          );
        // Render the theme body AND fetch the store's real nav (header menu + footer) in parallel —
        // the nav overlaps the slow isolate render, not the S3 load, and isn't fetched at all on a
        // bundle-miss fall-through. The body is rendered WITHOUT its layout (applyLayout:false); the
        // layout is applied as a final step below, once the chrome is ready — so header/footer flow
        // INTO the layout's {{ header }}/{{ footer }} slots from one nav read.
        const [{ html: sections, tags: dataTags }, [menu, footerData]] = await Promise.all([
          timed(c, 'compose', () =>
            renderThemePage(
              compiled,
              page,
              {
                // Theme sections: the bundle's Liquid, sandboxed in the isolate. Platform sections:
                // no Liquid in the bundle — resolve the type to the first-party record and render it
                // in-process (trusted code), so a page can mix both flavors. Platform sections resolve
                // to the LATEST registered version (unpinned) by design — "platform = centrally
                // updated" — unlike the legacy PageDoc path which pins the version it was built with.
                theme: (liquid, data) => renderUntrusted(liquid, data),
                platform: (type, data) => {
                  const rec = pbRegistry.get(type);
                  if (!rec) throw new Error(`unknown platform section '${type}'`);
                  // An island (per-user) section must NEVER render its personalized HTML into this
                  // shared, s-maxage'd response — emit the inert placeholder instead (hydrated
                  // client-side via /api/island), exactly as composePage does. (Instance = type for
                  // now — one island per type; full per-instance ids + island CSP on the bundle path
                  // are a later slice. Today no first-party section declares an island, so this is a
                  // fail-closed guard, not yet a live code path.)
                  if (rec.island)
                    return Promise.resolve(islandPlaceholder(rec.island.name, { instance: type }));
                  return renderSection(rec, data);
                },
              },
              {
                resolver,
                ctx: {
                  tenantId: tenantId as string,
                  routeParams: matched?.params,
                  commerce: tenant.commerce,
                },
                applyLayout: false,
              }
            )
          ),
          timed(c, 'nav', () =>
            Promise.all([fetchMainMenu(merchantId, navUrl), fetchFooter(merchantId, navUrl)])
          ),
        ]);
        // Header/footer are rendered from the THEME's editable header/footer sections (renderChrome)
        // with the store's real name + nav — the same header/footer the order page uses — and flow into
        // the layout's {{ header }}/{{ footer }} slots, so all pages share ONE header/footer.
        const { header, footer: footerHtml } = await timed(c, 'chrome', () =>
          renderChrome(compiled, (l, d) => renderUntrusted(l, d), {
            menu,
            footer: footerData,
            siteName: tenant.name,
          })
        );
        // External integrations (GoKwik side-cart + checkout) belong on EVERY storefront page, not
        // just cart/order — the side-cart drawer is how a shopper views the cart and opens on add,
        // so its widget must load on home/collection/product too. The fragments are store-level
        // (merchantInfo + a runtime cookie-token bridge), so the page stays edge-cacheable.
        const ix = composeGokwik(integrationContext(tenant.commerce, matched?.pageType ?? 'page'));
        const themeTokens = resolveThemeTokens(compiled, (tenant.theme ?? {}) as ThemeTokens);
        // The theme owns the whole document → render its layout/theme.liquid with the chrome + sections +
        // the platform-only slices (content_for_header/body_end) + brand tokens.
        const html = await timed(c, 'layout', () =>
          renderThemeLayout(compiled, (l, d) => renderUntrusted(l, d), {
            content_for_layout: sections,
            header,
            footer: footerHtml,
            content_for_header: ix.head,
            content_for_body_end: ix.bodyEnd,
            token_css: tokenCss(themeTokens),
            site_name: tenant.name,
          })
        );
        c.header('x-tenant', tenantId as string);
        c.header('x-handler', 'theme-bundle');
        c.header('x-theme-render', 'layout');
        c.header('x-theme-version', String(tenant.liveThemeVersion ?? ''));
        // Cacheable at the edge, invalidated by tag (D2): the tenant tag (a theme publish purges
        // every page of the store), the page tag (this URL), and the data-source tags (a
        // collection/product change purges the pages showing it). Emitting the tenant tag on every
        // bundle page is what lets the write side purge the whole store on publish/rollback.
        const tags = [
          tenantTag(tenantId as string),
          pageTag(tenantId as string, canon),
          ...dataTags,
        ];
        c.header('x-surrogate-keys', tags.join(' '));
        c.header('x-cache', 'long');
        c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
        setStorefrontSecurity(c, cspToString(mergeCsp(STOREFRONT_BASE_CSP, ix.csp)));
        return c.html(html);
      }
    } catch (e) {
      // A full-document invariant violation is a BUG (a broken live theme), not a transient hiccup —
      // rethrow so it 500s loudly instead of silently degrading to a 404 or stale page-builder content.
      if ((e as { fullDocumentViolation?: boolean } | null)?.fullDocumentViolation) throw e;
      // A bundle-store/render hiccup (S3, malformed bundle JSON, a resolver error) must not 500 the
      // very tenants using the new path — log and DEGRADE to the legacy page store below.
      logger.warn({
        evt: 'bundle_render_error',
        tenant: tenantId,
        err: e instanceof Error ? e.message : 'unknown',
      });
    }
  }

  // Page-builder render path — the DEGRADE-ONLY fallback (OFCE-616 / ADR-013 §14.6). The bundle theme
  // above is the primary renderer; we only reach here when the store has no live bundle theme (or its
  // bundle render hiccuped). A published PageDoc for the URL (exact or a shared template) is served —
  // this is what powers custom "Pages" (About/FAQ/landing) authored in the admin/assistant; a URL with
  // none is a 404. Onboarded bundle stores scaffold no PageDoc, so for them this branch 404s.
  {
    const canon = canonicalPath(path);
    // Routing (ADR-013): the router labels the URL (home / page / collection / product) and picks
    // the template. A custom doc AT this exact URL still wins (override); otherwise a shared
    // template serves it (one Collection template for every /collections/:handle, etc.). An
    // unrecognized path with a doc of its own still renders (pageType 'page').
    const matched: RouteMatch | null = matchRoute(canon);
    let doc = await timed(c, 'db_page', () => pageStore.getLive(tenantId as string, canon));
    let fromTemplate = false;
    if (!doc && matched && matched.templateKey !== canon) {
      doc = await timed(c, 'db_page', () =>
        pageStore.getLive(tenantId as string, matched.templateKey)
      );
      fromTemplate = true;
    }
    if (doc) {
      stats.renders++; // the expensive path — a cache HIT must not reach here
      // Resolve data sources (collection/product) via the CMS, interpolating the router's params
      // ({{params.handle}}), then compose. composePage stays pure — data goes in already resolved.
      const { doc: resolvedDoc, tags: dataTags } = await timed(c, 'data', () =>
        resolvePage(doc!, pbRegistry, resolver, {
          tenantId: tenantId as string,
          routeParams: matched?.params,
          commerce: tenant.commerce, // per-merchant data-layer creds (from the tenant record)
        })
      );
      // Header nav is chrome (ours), its menu is DATA (commerce backend, per-tenant). fetchMainMenu
      // returns the live menu, or the JSON fallback on any failure (unconfigured / no menu / error).
      // Static, so it rides the tenantTag (a menu change purges the store's pages).
      const [menu, footer] = await timed(c, 'nav', async () => {
        const m = await fetchMainMenu(
          tenant.commerce?.merchantId ?? '',
          process.env.COMMERCE_NAV_API_URL ?? ''
        );
        const f = await fetchFooter(
          tenant.commerce?.merchantId ?? '',
          process.env.COMMERCE_NAV_API_URL ?? ''
        );
        return [m, f] as const;
      });
      const ix = composeGokwik(integrationContext(tenant.commerce, matched?.pageType ?? 'page'));
      const composed = await timed(c, 'compose', () =>
        composePage(resolvedDoc, pbRegistry, tenant.theme ?? {}, {
          menu,
          footer,
          siteName: tenant.name,
          headExtra: ix.head,
          bodyEnd: ix.bodyEnd,
          islandsRuntimeUrl: islandsUrl,
        })
      );
      c.header('x-tenant', tenantId as string);
      c.header('x-handler', 'page-builder');
      c.header('x-page-type', matched?.pageType ?? 'page');
      c.header('x-page-tier', composed.tier);
      c.header('x-render-count', String(stats.renders));
      // Tag by the CONCRETE url so /collections/summer purges independently of /winter; when a
      // shared template rendered it, ALSO tag by the template so editing it purges every URL (D2);
      // and by each data source's tags (col:*/prod:*) so a CMS change purges the pages showing it.
      const tags = [pageTag(tenantId as string, canon), tenantTag(tenantId as string), ...dataTags];
      if (fromTemplate) tags.push(pageTag(tenantId as string, matched!.templateKey));
      c.header('x-surrogate-keys', tags.join(' '));
      c.header('x-cache', composed.cacheable ? 'long' : 'no-store');
      if (composed.cacheable)
        c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
      // An island page relaxes the strict no-JS base by exactly what the runtime needs (self script
      // + same-origin fetch); a page with no island keeps script-src 'none'. Integration CSP merges
      // on top of either.
      const baseCsp = composed.hasIsland
        ? mergeCsp(STOREFRONT_BASE_CSP, ISLANDS_CSP)
        : STOREFRONT_BASE_CSP;
      setStorefrontSecurity(c, cspToString(mergeCsp(baseCsp, ix.csp)));
      return c.html(composed.html);
    }
    // No published page for this URL (exact or template) → 404. The page builder is the sole
    // renderer; there is no legacy content-model fallback.
    c.header('x-tenant', tenantId as string);
    c.header('x-cache', 'no-store');
    setStorefrontSecurity(c);
    return c.html(`<h1>404 — ${esc(tenant.name)}</h1><p>no page for ${esc(path)}</p>`, 404);
  }
}
