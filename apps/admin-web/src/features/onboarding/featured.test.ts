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

  test('only patches the rows given a handle', () => {
    const out = mapFeaturedCollections({ [INDEX]: baseIndex() }, { newArrivals: 'summer' });
    expect(readFeatured(out)).toEqual({ newArrivals: 'summer', trending: 'new-launches' });
  });

  test('returns the files unchanged when the template is not the expected shape', () => {
    const files = { [INDEX]: JSON.stringify({ sections: [] }) };
    expect(mapFeaturedCollections(files, { newArrivals: 'summer' })).toBe(files);
    expect(mapFeaturedCollections({}, { newArrivals: 'summer' })).toEqual({});
  });
});
