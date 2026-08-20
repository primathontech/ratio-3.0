// The design-token vocabulary now lives in @ratio/design-tokens — the single source of truth shared
// with the admin-web editor (so backend scales and editor scales can't drift). This module stays as a
// thin re-export so existing importers of '../theme/token-spec' keep working. The value maps
// (FONTS/BASE_SIZE/RADIUS/CONTAINER) are re-exported from storefront.ts, so re-export only the
// primitive/semantic scale + generator here to avoid a duplicate-name clash in the package barrel.
export { PRIMITIVES, SEMANTIC_DEFAULTS, defaultTokensCss } from '@ratio/design-tokens';
