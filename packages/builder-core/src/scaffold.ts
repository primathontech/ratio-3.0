// Default storefront pages every store gets at creation, so it renders out of the box — no manual
// authoring needed before navigation works. The home is a plain hero (the merchant edits it); the
// product/collection templates use {{params.handle}}, so /products/anything and /collections/anything
// resolve. The page builder is the sole renderer, so without these a fresh URL would 404.
import type { PageDoc } from './doc';
import type { PageBuilder } from './store';

export function defaultStorefrontTemplates(opts?: { name?: string }): PageDoc[] {
  const name = opts?.name ?? 'Store';
  return [
    {
      path: '/',
      title: 'Home',
      sections: [
        {
          id: 'hero',
          type: 'hero',
          data: { hero: { heading: name, sub: 'Welcome to ' + name } },
        },
      ],
    },
    {
      path: '/collections/:handle',
      title: 'Collection',
      dataSources: {
        main: {
          type: 'COLLECTION_BY_HANDLES',
          params: { handles: ['{{params.handle}}'], productLimit: 12 },
        },
      },
      sections: [{ id: 'grid', type: 'productGrid', dataSourceKey: 'main', data: { grid: {} } }],
    },
    {
      path: '/products/:handle',
      title: 'Product',
      dataSources: { main: { type: 'PRODUCT', params: { handle: '{{params.handle}}' } } },
      sections: [{ id: 'pdp', type: 'product', dataSourceKey: 'main', data: {} }],
    },
  ];
}

// Publish the defaults for a new store. Draft → publish each, so the origin serves them immediately.
export async function scaffoldStorefront(
  pb: PageBuilder,
  tenantId: string,
  opts?: { name?: string }
): Promise<void> {
  for (const doc of defaultStorefrontTemplates(opts)) {
    await pb.saveDraft(tenantId, doc);
    await pb.publish(tenantId, doc.path);
  }
}
