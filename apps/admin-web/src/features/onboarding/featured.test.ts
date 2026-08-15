import { describe, test, expect } from 'vitest';
import { readFeatured, mapFeaturedCollections } from './featured';

const INDEX = 'templates/index.json';
const baseIndex = () =>
  JSON.stringify({
    dataSources: {
      new_arrivals: {
        type: 'COLLECTION_BY_HANDLES',
        params: { handles: ['new-arrivals'], productLimit: 8 },
      },
      trending: {
        type: 'COLLECTION_BY_HANDLES',
        params: { handles: ['trending'], productLimit: 8 },
      },
    },
    sections: [{ type: 'header' }],
  });

describe('readFeatured', () => {
  test('reads the current featured-row handles', () => {
    expect(readFeatured({ [INDEX]: baseIndex() })).toEqual({
      newArrivals: 'new-arrivals',
      trending: 'trending',
    });
  });
  test('empty when the template is missing or malformed', () => {
    expect(readFeatured({})).toEqual({ newArrivals: '', trending: '' });
    expect(readFeatured({ [INDEX]: '{bad' })).toEqual({ newArrivals: '', trending: '' });
  });
});

describe('mapFeaturedCollections', () => {
  test('rebinds the chosen collections, preserving other params + files', () => {
    const files = { [INDEX]: baseIndex(), 'sections/header.liquid': '<header></header>' };
    const out = mapFeaturedCollections(files, { newArrivals: 'summer', trending: 'best-sellers' });
    expect(out['sections/header.liquid']).toBe('<header></header>'); // untouched
    const doc = JSON.parse(out[INDEX]);
    expect(doc.dataSources.new_arrivals.params.handles).toEqual(['summer']);
    expect(doc.dataSources.trending.params.handles).toEqual(['best-sellers']);
    expect(doc.dataSources.new_arrivals.params.productLimit).toBe(8); // other params preserved
    expect(readFeatured(out)).toEqual({ newArrivals: 'summer', trending: 'best-sellers' });
  });

  test('only patches the rows given a handle', () => {
    const out = mapFeaturedCollections({ [INDEX]: baseIndex() }, { newArrivals: 'summer' });
    expect(readFeatured(out)).toEqual({ newArrivals: 'summer', trending: 'trending' });
  });

  test('returns the files unchanged when the template is not the expected shape', () => {
    const files = { [INDEX]: JSON.stringify({ sections: [] }) };
    expect(mapFeaturedCollections(files, { newArrivals: 'summer' })).toBe(files);
    expect(mapFeaturedCollections({}, { newArrivals: 'summer' })).toEqual({});
  });
});
