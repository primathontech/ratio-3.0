// Map the merchant's real collections into the default theme's two featured home rows (New arrivals /
// Trending) during onboarding, by patching the collection handles those rows bind to in
// templates/index.json. This is what stops a fresh store launching with empty featured rows when the
// merchant's catalogue doesn't happen to use the theme's default handles.
//
// The two rows are found by POSITION — the first and second `collection-row` sections, in order — not
// by hard-coded dataSource key names. The default theme is free to name its dataSource keys anything
// (and does change them); keying off the section order keeps onboarding working regardless.
import type { ThemeFiles } from '../../common/api';

const INDEX = 'templates/index.json';
const COLLECTION_ROW = 'collection-row';

export interface Featured {
  newArrivals: string;
  trending: string;
}

interface IndexDoc {
  dataSources?: Record<
    string,
    { type?: string; params?: { handles?: string[]; filters?: unknown[]; [k: string]: unknown } }
  >;
  sections?: { type?: string; dataSourceKey?: string }[];
}

function parse(raw: string | undefined): IndexDoc | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as IndexDoc) : null;
  } catch {
    return null;
  }
}

// The dataSource keys the featured collection-row sections bind to, in render order.
function featuredKeys(doc: IndexDoc | null): string[] {
  return (doc?.sections ?? [])
    .filter((s) => s?.type === COLLECTION_ROW && typeof s.dataSourceKey === 'string')
    .map((s) => s.dataSourceKey as string);
}

function firstHandle(doc: IndexDoc | null, key: string | undefined): string {
  const h = key ? doc?.dataSources?.[key]?.params?.handles : undefined;
  return Array.isArray(h) && typeof h[0] === 'string' ? h[0] : '';
}

// The collection handles the home's two featured rows currently bind to (from the theme draft).
export function readFeatured(files: ThemeFiles): Featured {
  const doc = parse(files[INDEX]);
  const [newArrivalsKey, trendingKey] = featuredKeys(doc);
  return {
    newArrivals: firstHandle(doc, newArrivalsKey),
    trending: firstHandle(doc, trendingKey),
  };
}

// Patch the home template so the featured rows bind to the chosen real collections. Defensive: if the
// template isn't the expected shape (a merchant may have edited it), or nothing is selected, the files
// are returned unchanged.
export function mapFeaturedCollections(files: ThemeFiles, sel: Partial<Featured>): ThemeFiles {
  const doc = parse(files[INDEX]);
  if (!doc?.dataSources) return files;
  const [newArrivalsKey, trendingKey] = featuredKeys(doc);
  let changed = false;
  for (const [key, handle] of [
    [newArrivalsKey, sel.newArrivals],
    [trendingKey, sel.trending],
  ] as const) {
    const ds = key ? doc.dataSources[key] : undefined;
    if (handle && ds) {
      // The default home rows are a handle-INDEPENDENT product listing (type PRODUCTS), so a fresh
      // store is never empty. Selecting a collection binds this row to it: switch the row to a
      // collection source (full catalogue, matching the collection page) with the chosen handle. Write
      // a clean collection param set — carry over productLimit if present (default 8) and drop the
      // listing-only params (first/sortKey/reverse) that a collection source doesn't use.
      const productLimit = typeof ds.params?.productLimit === 'number' ? ds.params.productLimit : 8;
      const filters = Array.isArray(ds.params?.filters)
        ? ds.params.filters
        : [{ available: false }];
      ds.type = 'COLLECTION_BY_HANDLES';
      ds.params = { handles: [handle], productLimit, filters };
      changed = true;
    }
  }
  return changed ? { ...files, [INDEX]: `${JSON.stringify(doc, null, 2)}\n` } : files;
}
