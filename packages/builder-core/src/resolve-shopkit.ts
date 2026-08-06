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

type RawProduct = Record<string, unknown> & { id?: string | number };

// COLLECTION_BY_HANDLES response = [{ handle, data:{products} | products }] — flatten the products
// out of the response ENVELOPE. The product objects themselves are passed through UNMODIFIED; any
// shaping/formatting (paise→rupees, image pick, href) happens at render (consumer-driven).
function collectionProducts(data: unknown): RawProduct[] {
  const entries = Array.isArray(data) ? data : [];
  return entries.flatMap(
    (e: { data?: { products?: RawProduct[] }; products?: RawProduct[] }) =>
      e?.data?.products ?? e?.products ?? []
  );
}
function productList(data: unknown): RawProduct[] {
  if (Array.isArray(data)) return data as RawProduct[];
  return ((data as { products?: RawProduct[] })?.products ?? []) as RawProduct[];
}

export class ShopkitResolver implements BindingResolver {
  constructor(private clientFor: (ctx: ResolveContext) => ICommerceClient | null) {}

  async fetch(source: DataSource, ctx: ResolveContext): Promise<ResolvedSource> {
    const client = this.clientFor(ctx);
    if (!client) return { value: {}, tags: [] }; // tenant not connected to the backend → no data
    const params = (source.params ?? {}) as Record<string, unknown>;
    const options = source.options as never;

    switch (source.type) {
      case DATA_SOURCE_TYPES.COLLECTION_BY_HANDLES:
      case DATA_SOURCE_TYPES.COLLECTION: {
        const res: IResponse =
          source.type === DATA_SOURCE_TYPES.COLLECTION
            ? await client.getCollection(params as never, options)
            : await client.getCollectionsByHandles(params as never, options);
        const products = collectionProducts(res.data); // canonical, unmodified
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
        const products = productList(res.data);
        return { value: { products }, tags: products.map((p) => `prod:${p.id}`) };
      }
      case DATA_SOURCE_TYPES.PRODUCT: {
        const res: IResponse = await client.getProduct(params as never, options);
        const product = (res.data ?? {}) as RawProduct; // canonical product, passed through
        return { value: product, tags: [`prod:${product.id ?? params.handle}`] };
      }
      default:
        return { value: {}, tags: [] };
    }
  }
}

// Platform-global service base URLs (one backend for every merchant) — env, not per-tenant.
export interface CustomBackendUrls {
  productApiBaseUrl: string;
  cartApiBaseUrl: string;
  orderApiBaseUrl: string;
}

// Build a custom CommerceClient from per-tenant creds (DB) + platform URLs (env). Null when the
// tenant has no merchantId (not connected). Shared by the resolver AND the admin collection list.
export function buildCustomClient(
  commerce: { merchantId?: string; storeId?: string } | null | undefined,
  urls: CustomBackendUrls
): ICommerceClient | null {
  const merchantId = commerce?.merchantId;
  if (!merchantId) return null;
  const storeId = commerce?.storeId ?? merchantId; // storeId defaults to merchantId for now
  return createCommerceClient({
    type: 'custom',
    config: {
      merchantId,
      storeId,
      services: {
        product: { apiBaseUrl: urls.productApiBaseUrl },
        cart: { apiBaseUrl: urls.cartApiBaseUrl },
        order: { apiBaseUrl: urls.orderApiBaseUrl },
      },
    } as ICustomConfig,
  });
}

// Platform service URLs from env, or null if not configured.
export function commerceUrlsFromEnv(env: NodeJS.ProcessEnv): CustomBackendUrls | null {
  const productApiBaseUrl = env.COMMERCE_PRODUCT_API_URL;
  const cartApiBaseUrl = env.COMMERCE_CART_API_URL;
  const orderApiBaseUrl = env.COMMERCE_ORDER_API_URL;

  if (!productApiBaseUrl || !cartApiBaseUrl || !orderApiBaseUrl) return null;
  return {
    productApiBaseUrl,
    cartApiBaseUrl,
    orderApiBaseUrl,
  };
}

// Build a resolver whose client is constructed PER-TENANT (platform URLs + ctx.commerce from DB).
export function customCommerceResolver(urls: CustomBackendUrls): ShopkitResolver {
  return new ShopkitResolver((ctx) => buildCustomClient(ctx.commerce, urls));
}

// Origin factory: real resolver when the platform URLs are configured, else null (caller falls back
// to the stub, so local dev without a backend still renders). Per-merchant creds come from the DB.
export function commerceResolverFromEnv(env: NodeJS.ProcessEnv): ShopkitResolver | null {
  const urls = commerceUrlsFromEnv(env);
  return urls ? customCommerceResolver(urls) : null;
}
