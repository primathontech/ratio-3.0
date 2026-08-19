import { describe, test, expect } from 'vitest';
import { readFeatured, mapFeaturedCollections } from './featured';

const INDEX = 'templates/index.json';
// The two featured rows are the collection-row sections, in order. Their dataSource keys are
// deliberately NOT 'new_arrivals'/'trending' here — the theme renames them (e.g. to 'all' /
// 'new-launches'), and onboarding must still map by position. Keying off names is the bug this guards.
const baseIndex = () =>
  JSON.stringify({
    sections: [
      { type: 'hero' },
      { type: 'promo' },
      { type: 'collection-row', dataSourceKey: 'all' },
      { type: 'collection-row', dataSourceKey: 'new-launches' },
      { type: 'brand-story' },
    ],
    dataSources: {
      all: {
        type: 'COLLECTION_BY_HANDLES',
        params: { handles: ['all'], productLimit: 8 },
      },
      'new-launches': {
        type: 'COLLECTION_BY_HANDLES',
        params: { handles: ['new-launches'], productLimit: 8 },
      },
    },
  });

// The default theme's home: two product-listing rows (handle-independent), so a fresh store is never
// empty. Selecting a collection during onboarding must switch a row to a collection source.
const productListingIndex = () =>
  JSON.stringify({
    sections: [
      { type: 'hero' },
      { type: 'promo' },
      { type: 'collection-row', dataSourceKey: 'featured' },
      { type: 'collection-row', dataSourceKey: 'latest' },
      { type: 'brand-story' },
    ],
    dataSources: {
      featured: { type: 'PRODUCTS', params: { first: 8 } },
      latest: {
        type: 'PRODUCTS',
        params: { first: 8, sortKey: 'CREATED_AT', reverse: true },
      },
    },
  });

describe('readFeatured', () => {
  test('reads the current featured-row handles (by section position, any key names)', () => {
    expect(readFeatured({ [INDEX]: baseIndex() })).toEqual({
      newArrivals: 'all',
      trending: 'new-launches',
    });
  });
  test('empty when the template is missing or malformed', () => {
    expect(readFeatured({})).toEqual({ newArrivals: '', trending: '' });
    expect(readFeatured({ [INDEX]: '{bad' })).toEqual({ newArrivals: '', trending: '' });
  });
  test('empty for the default product-listing home (rows have no preselected collection)', () => {
    // The default theme's home rows are a handle-independent PRODUCTS listing — nothing to preselect.
    expect(readFeatured({ [INDEX]: productListingIndex() })).toEqual({
      newArrivals: '',
      trending: '',
    });
  });
});

describe('mapFeaturedCollections', () => {
  test('rebinds the chosen collections, preserving other params + files', () => {
    const files = { [INDEX]: baseIndex(), 'sections/hero.liquid': '<section></section>' };
    const out = mapFeaturedCollections(files, { newArrivals: 'summer', trending: 'best-sellers' });
    expect(out['sections/hero.liquid']).toBe('<section></section>'); // untouched
    const doc = JSON.parse(out[INDEX]);
    expect(doc.dataSources.all.params.handles).toEqual(['summer']);
    expect(doc.dataSources['new-launches'].params.handles).toEqual(['best-sellers']);
    expect(doc.dataSources.all.params.productLimit).toBe(8); // other params preserved
    expect(readFeatured(out)).toEqual({ newArrivals: 'summer', trending: 'best-sellers' });
  });

  test('maps by section position even when the theme uses non-default dataSource keys (regression: onboarding selection did not reflect live)', () => {
    // The real bug: the theme's home rows bound keys 'all' / 'new-launches', but the mapper looked up
    // 'new_arrivals' / 'trending' and silently no-op'd, so the merchant's picks never reached the theme.
    const out = mapFeaturedCollections(
      { [INDEX]: baseIndex() },
      { newArrivals: 'my-featured', trending: 'my-trending' }
    );
    expect(readFeatured(out)).toEqual({ newArrivals: 'my-featured', trending: 'my-trending' });
  });

  test('switches a default product-listing row to a collection source when a handle is chosen', () => {
    const out = mapFeaturedCollections(
      { [INDEX]: productListingIndex() },
      { newArrivals: 'summer', trending: 'winter' }
    );
    const doc = JSON.parse(out[INDEX]);
    expect(doc.dataSources.featured.type).toBe('COLLECTION_BY_HANDLES');
    expect(doc.dataSources.featured.params.handles).toEqual(['summer']);
    expect(doc.dataSources.featured.params.filters).toEqual([{ available: false }]); // full catalogue
    expect(doc.dataSources.featured.params.productLimit).toBe(8); // collection page-size
    // Listing-only params don't belong on a collection source and must not linger.
    expect(doc.dataSources.latest.params.first).toBeUndefined();
    expect(doc.dataSources.latest.params.sortKey).toBeUndefined();
    expect(doc.dataSources.latest.params.reverse).toBeUndefined();
    expect(doc.dataSources.latest.type).toBe('COLLECTION_BY_HANDLES');
    expect(readFeatured(out)).toEqual({ newArrivals: 'summer', trending: 'winter' });
  });

  test('only patches the rows given a handle', () => {
    const out = mapFeaturedCollections({ [INDEX]: baseIndex() }, { newArrivals: 'summer' });
    expect(readFeatured(out)).toEqual({ newArrivals: 'summer', trending: 'new-launches' });
  });

  test('selecting All products (empty handle) reverts a collection-bound row to the products listing', () => {
    // baseIndex binds the first row to COLLECTION_BY_HANDLES['all']. Choosing "All products" must
    // revert it to the handle-independent PRODUCTS listing (renders for every store), not leave the
    // old collection bound.
    const out = mapFeaturedCollections({ [INDEX]: baseIndex() }, { newArrivals: '' });
    const doc = JSON.parse(out[INDEX]);
    expect(doc.dataSources.all.type).toBe('PRODUCTS');
    expect(doc.dataSources.all.params.handles).toBeUndefined();
    expect(doc.dataSources.all.params.first).toBe(8);
    // The unspecified trending row is left exactly as it was.
    expect(doc.dataSources['new-launches'].params.handles).toEqual(['new-launches']);
  });

  test('an unspecified row (undefined) is left alone, not reverted', () => {
    const out = mapFeaturedCollections({ [INDEX]: baseIndex() }, { newArrivals: 'summer' });
    const doc = JSON.parse(out[INDEX]);
    expect(doc.dataSources['new-launches'].type).toBe('COLLECTION_BY_HANDLES');
  });

  test('a row already on the products listing is untouched by All products (no churn)', () => {
    const files = { [INDEX]: productListingIndex() };
    expect(mapFeaturedCollections(files, { newArrivals: '' })).toBe(files);
  });

  test('returns the files unchanged when the template is not the expected shape', () => {
    const files = { [INDEX]: JSON.stringify({ sections: [] }) };
    expect(mapFeaturedCollections(files, { newArrivals: 'summer' })).toBe(files);
    expect(mapFeaturedCollections({}, { newArrivals: 'summer' })).toEqual({});
  });
});
