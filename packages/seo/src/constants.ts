// SEO constants (schema.org vocabulary + defaults), ported from storefront-2.0 @shopkit/seo. Trimmed to
// what this package actually emits — the speculative scoring/validation/image-size tables were dropped.
export const SEO_CONSTANTS = {
  SCHEMA_CONTEXT: 'https://schema.org',
  DEFAULT_CURRENCY: 'INR',

  SCHEMA_TYPES: {
    ORGANIZATION: 'Organization',
    WEBSITE: 'WebSite',
    PRODUCT: 'Product',
    OFFER: 'Offer',
    BRAND: 'Brand',
    BREADCRUMB_LIST: 'BreadcrumbList',
    LIST_ITEM: 'ListItem',
    COLLECTION_PAGE: 'CollectionPage',
    ITEM_LIST: 'ItemList',
  },

  AVAILABILITY_STATES: {
    IN_STOCK: 'https://schema.org/InStock',
    OUT_OF_STOCK: 'https://schema.org/OutOfStock',
    PRE_ORDER: 'https://schema.org/PreOrder',
  },

  PRODUCT_CONDITIONS: {
    NEW: 'https://schema.org/NewCondition',
    USED: 'https://schema.org/UsedCondition',
    REFURBISHED: 'https://schema.org/RefurbishedCondition',
  },

  CHANGE_FREQUENCIES: {
    ALWAYS: 'always',
    HOURLY: 'hourly',
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
    NEVER: 'never',
  },

  PRIORITIES: {
    HOMEPAGE: 1.0,
    MAIN_CATEGORIES: 0.9,
    PRODUCTS: 0.8,
    COLLECTIONS: 0.7,
    STATIC_PAGES: 0.5,
  },
} as const;

// Facet/sort/pagination params create an unbounded, low-value URL space — keep those variants out of the
// index (the canonical still consolidates them). Matches storefront-2.0's crawl-budget rule; a plain
// ?utm=… share URL stays indexable. NOTE: when storefront filters/sort/pagination ship (OFCE-722),
// confirm the real query-param names match this pattern (or extend it) — this is the single source.
export const NOINDEX_SEARCH_PARAM = /^(sort_by|filter\.|page$)/;
