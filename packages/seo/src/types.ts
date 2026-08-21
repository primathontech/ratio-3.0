// Public types for @ratio/seo. Deliberately small — the storefront-2.0 type surface (validation/analysis/
// analytics/i18n) is out of scope until those features land in v3.

// A schema.org JSON-LD object. Open-ended by design (schema.org has hundreds of properties).
export interface StructuredDataSchema {
  '@context': string;
  '@type': string;
  [key: string]: unknown;
}

// The site-level context every structured-data / head builder needs.
export interface SeoConfig {
  siteName: string;
  siteUrl: string; // absolute origin, e.g. https://shop.example (no trailing slash required)
  currency?: string; // ISO 4217; defaults to INR
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

// A canonical product as the commerce backend returns it (paise prices, image_url|images[], price on
// variants[0].price.amount or a top-level fallback). Every field optional — extraction is best-effort.
export interface ProductLike {
  id?: string | number;
  title?: string;
  name?: string;
  handle?: string;
  seo_title?: string;
  seo_description?: string;
  seo?: { title?: string; description?: string };
  description?: string;
  image_url?: string;
  images?: Array<{ url?: string; src?: string; is_main?: boolean; altText?: string }>;
  image?: { url?: string };
  price?: number; // paise (fallback)
  variants?: Array<{ price?: { amount?: number } }>;
  currency?: string;
  available?: boolean;
  sku?: string;
  brand?: string;
  gtin?: string;
  barcode?: string;
}

// SEO fields extracted from a ProductLike, normalized for the schema/head builders.
export interface ProductSeoFields {
  title?: string;
  description?: string;
  images: string[]; // absolute urls, is_main first, deduped
  priceMinor?: number; // paise
  currency?: string;
  available?: boolean;
  sku?: string;
  brand?: string;
  gtin?: string;
}

export interface SitemapEntry {
  path: string; // site-relative, e.g. '/products/shoe'
  lastModified?: string; // ISO date string
  changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}
