// Real BindingResolver over @shopkit/data-layer's CUSTOM backend adapter (merchantId + storeId +
// per-service base URLs). Dispatches our DATA_SOURCE_TYPES to the CommerceClient methods and maps
// the (backend-shaped) response into the section binding shape — the transform reused from 2.0
// (momsco): prices come in PAISE, product image is image_url|images[], price is variants[0] or
// product.price. Kept in its own file so resolve.ts stays dependency-free.

import { createCommerceClient } from '@shopkit/data-layer';
import type { ICommerceClient, ICustomConfig, IResponse } from '@shopkit/data-layer';
import type { BindingResolver, ResolveContext, ResolvedSource } from './resolve';
import type { DataSource } from './doc';
import { DATA_SOURCE_TYPES } from './doc';

interface ApiProduct {
  id?: string | number;
  handle?: string;
  title?: string;
  price?: unknown; // paise
  image_url?: string;
  images?: { url: string; is_main?: boolean }[];
  variants?: { price?: { amount?: unknown } }[];
}

const paiseToRupees = (paise: unknown): number => {
  const n = Number(paise);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
};

// One backend product → the shape the productGrid / product templates read.
function toCard(p: ApiProduct): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    href: p.handle ? `/products/${p.handle}` : '#',
    image: p.image_url || p.images?.find((i) => i.is_main)?.url || p.images?.[0]?.url || '',
    price: paiseToRupees(p.variants?.[0]?.price?.amount ?? p.price),
  };
}

// COLLECTION_BY_HANDLES response = [{ handle, data:{products} | products }] — flatten the products.
function collectionProducts(data: unknown): ApiProduct[] {
  const entries = Array.isArray(data) ? data : [];
  return entries.flatMap(
    (e: { data?: { products?: ApiProduct[] }; products?: ApiProduct[] }) =>
      e?.data?.products ?? e?.products ?? []
  );
}
function productList(data: unknown): ApiProduct[] {
  if (Array.isArray(data)) return data as ApiProduct[];
  return ((data as { products?: ApiProduct[] })?.products ?? []) as ApiProduct[];
}

export class ShopkitResolver implements BindingResolver {
  constructor(private clientFor: (ctx: ResolveContext) => ICommerceClient) {}

  async fetch(source: DataSource, ctx: ResolveContext): Promise<ResolvedSource> {
    const client = this.clientFor(ctx);
    const params = (source.params ?? {}) as Record<string, unknown>;
    const options = source.options as never;

    switch (source.type) {
      case DATA_SOURCE_TYPES.COLLECTION_BY_HANDLES:
      case DATA_SOURCE_TYPES.COLLECTION: {
        const res: IResponse =
          source.type === DATA_SOURCE_TYPES.COLLECTION
            ? await client.getCollection(params as never, options)
            : await client.getCollectionsByHandles(params as never, options);
        const products = collectionProducts(res.data).map(toCard);
        const handles =
          (params.handles as string[] | undefined) ??
          (params.handle ? [String(params.handle)] : []);
        return {
          value: { products },
          tags: [...handles.map((h) => `col:${h}`), ...products.map((p) => `prod:${p.id}`)],
        };
      }
      case DATA_SOURCE_TYPES.PRODUCTS:
      case DATA_SOURCE_TYPES.PRODUCTS_BY_HANDLES: {
        const res: IResponse =
          source.type === DATA_SOURCE_TYPES.PRODUCTS_BY_HANDLES
            ? await client.getProductsByHandles(params as never, options)
            : await client.getProducts(params as never, options);
        const products = productList(res.data).map(toCard);
        return { value: { products }, tags: products.map((p) => `prod:${p.id}`) };
      }
      case DATA_SOURCE_TYPES.PRODUCT: {
        const res: IResponse = await client.getProduct(params as never, options);
        const card = toCard((res.data ?? {}) as ApiProduct);
        return { value: card, tags: [`prod:${card.id ?? params.handle}`] };
      }
      default:
        return { value: {}, tags: [] };
    }
  }
}

// Build a per-tenant custom CommerceClient. Service base URLs are platform config; merchantId/storeId
// identify the store. Defaults storeId to our tenant id — CONFIRM this matches the backend's store
// identifier; if not, resolve it from the tenant record instead.
export interface CustomBackendConfig {
  productApiBaseUrl: string;
  cartApiBaseUrl?: string;
  orderApiBaseUrl?: string;
  merchantId: string;
  storeIdFor?: (ctx: ResolveContext) => string;
}
export function customCommerceResolver(cfg: CustomBackendConfig): ShopkitResolver {
  const storeIdFor = cfg.storeIdFor ?? ((ctx) => ctx.tenantId);
  return new ShopkitResolver((ctx) =>
    createCommerceClient({
      type: 'custom',
      config: {
        merchantId: cfg.merchantId,
        storeId: storeIdFor(ctx),
        services: {
          product: { apiBaseUrl: cfg.productApiBaseUrl },
          cart: { apiBaseUrl: cfg.cartApiBaseUrl ?? cfg.productApiBaseUrl },
          order: { apiBaseUrl: cfg.orderApiBaseUrl ?? cfg.productApiBaseUrl },
        },
      } as ICustomConfig,
    })
  );
}

// Origin factory: use the real resolver when the backend is configured, else null (caller falls
// back to the stub, so local dev without a backend still renders).
export function commerceResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ShopkitResolver | null {
  const productApiBaseUrl = env.COMMERCE_PRODUCT_API_URL;
  const merchantId = env.COMMERCE_MERCHANT_ID;
  if (!productApiBaseUrl || !merchantId) return null;
  return customCommerceResolver({
    productApiBaseUrl,
    cartApiBaseUrl: env.COMMERCE_CART_API_URL,
    orderApiBaseUrl: env.COMMERCE_ORDER_API_URL,
    merchantId,
  });
}
