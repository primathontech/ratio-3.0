// schema.org structured-data builders, ported from storefront-2.0's StructuredDataGenerator. Pure
// functions (not a stateful class) taking an explicit SeoConfig, so each is a standalone util method.
// Absent fields are omitted rather than emitted empty. Prices are PAISE in (canonical backend unit),
// converted to major units here — the one v3 divergence from v2, which passed price through raw.
import { SEO_CONSTANTS as C } from './constants';
import { metaText } from './extract';
import type { BreadcrumbItem, ProductSeoFields, SeoConfig, StructuredDataSchema } from './types';

export interface ProductSchemaInput extends ProductSeoFields {
  name: string;
  url: string; // absolute canonical product URL
}

// schema.org/Product for rich product results.
export function productSchema(p: ProductSchemaInput, config: SeoConfig): StructuredDataSchema {
  const brand = p.brand ?? config.siteName;
  const schema: StructuredDataSchema = {
    '@context': C.SCHEMA_CONTEXT,
    '@type': C.SCHEMA_TYPES.PRODUCT,
    name: p.name,
    url: p.url,
  };
  if (p.description) schema.description = metaText(p.description, 5000);
  if (p.images.length) schema.image = p.images;
  if (p.sku) schema.sku = p.sku;
  if (p.gtin) schema.gtin = p.gtin;
  if (brand) schema.brand = { '@type': C.SCHEMA_TYPES.BRAND, name: brand };
  if (typeof p.priceMinor === 'number' && p.priceMinor >= 0) {
    schema.offers = {
      '@type': C.SCHEMA_TYPES.OFFER,
      url: p.url,
      price: (p.priceMinor / 100).toFixed(2),
      priceCurrency: p.currency ?? config.currency ?? C.DEFAULT_CURRENCY,
      availability:
        p.available === false ? C.AVAILABILITY_STATES.OUT_OF_STOCK : C.AVAILABILITY_STATES.IN_STOCK,
      itemCondition: C.PRODUCT_CONDITIONS.NEW,
      seller: { '@type': C.SCHEMA_TYPES.ORGANIZATION, name: config.siteName },
    };
  }
  return schema;
}

export interface CollectionSchemaInput {
  name: string;
  url: string;
  description?: string;
  image?: string;
  products?: Array<{ title?: string; name?: string; handle?: string; image?: string }>;
}

// schema.org/CollectionPage with an ItemList of the first products.
export function collectionSchema(
  col: CollectionSchemaInput,
  config: SeoConfig
): StructuredDataSchema {
  const base = config.siteUrl.replace(/\/$/, '');
  const schema: StructuredDataSchema = {
    '@context': C.SCHEMA_CONTEXT,
    '@type': C.SCHEMA_TYPES.COLLECTION_PAGE,
    name: col.name,
    url: col.url,
  };
  if (col.description) schema.description = metaText(col.description, 5000);
  if (col.image) schema.image = col.image;
  const products = col.products ?? [];
  if (products.length) {
    schema.mainEntity = {
      '@type': C.SCHEMA_TYPES.ITEM_LIST,
      numberOfItems: products.length,
      itemListElement: products.slice(0, 10).map((pr, i) => ({
        '@type': C.SCHEMA_TYPES.LIST_ITEM,
        position: i + 1,
        item: {
          '@type': C.SCHEMA_TYPES.PRODUCT,
          name: pr.title || pr.name,
          url: pr.handle ? `${base}/products/${pr.handle}` : undefined,
          image: pr.image,
        },
      })),
    };
  }
  return schema;
}

// schema.org/Organization.
export function organizationSchema(config: SeoConfig): StructuredDataSchema {
  return {
    '@context': C.SCHEMA_CONTEXT,
    '@type': C.SCHEMA_TYPES.ORGANIZATION,
    name: config.siteName,
    url: config.siteUrl.replace(/\/$/, ''),
  };
}

// schema.org/WebSite. The Sitelinks Searchbox SearchAction is intentionally omitted until storefront
// search ships (OFCE-722) — advertising a missing /search endpoint would be dishonest.
export function websiteSchema(config: SeoConfig): StructuredDataSchema {
  return {
    '@context': C.SCHEMA_CONTEXT,
    '@type': C.SCHEMA_TYPES.WEBSITE,
    name: config.siteName,
    url: config.siteUrl.replace(/\/$/, ''),
  };
}

// schema.org/BreadcrumbList. Null when empty (nothing to emit).
export function breadcrumbSchema(items: BreadcrumbItem[]): StructuredDataSchema | null {
  if (!items.length) return null;
  return {
    '@context': C.SCHEMA_CONTEXT,
    '@type': C.SCHEMA_TYPES.BREADCRUMB_LIST,
    itemListElement: items.map((c, i) => ({
      '@type': C.SCHEMA_TYPES.LIST_ITEM,
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

// Deep-remove undefined/null so a partially-populated schema never emits empty keys.
export function validateSchema(schema: StructuredDataSchema): StructuredDataSchema {
  return JSON.parse(JSON.stringify(schema, (_k, v) => (v == null ? undefined : v)));
}
