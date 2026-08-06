// Default storefront templates every store gets at creation, so product and collection URLs render
// out of the box — no manual authoring needed before navigation works. One template each: the
// router fills {{params.handle}} per URL, so /products/anything and /collections/anything resolve.
// (The home is served by the content model / the merchant's own page for now.)
import type { PageDoc } from './doc';
import type { PageBuilder } from './store';

export function defaultStorefrontTemplates(): PageDoc[] {
  return [
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
export async function scaffoldStorefront(pb: PageBuilder, tenantId: string): Promise<void> {
  for (const doc of defaultStorefrontTemplates()) {
    await pb.saveDraft(tenantId, doc);
    await pb.publish(tenantId, doc.path);
  }
}
