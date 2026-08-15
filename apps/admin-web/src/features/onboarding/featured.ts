// Map the merchant's real collections into the default theme's two featured home rows (New arrivals /
// Trending) during onboarding, by patching the collection handles the rows bind to in
// templates/index.json. This is what stops a fresh store launching with empty featured rows when the
// merchant's catalogue doesn't happen to use the default 'new-arrivals' / 'trending' handles.
import type { ThemeFiles } from '../../common/api';

const INDEX = 'templates/index.json';
// The dataSource keys the default theme's home template gives its two collection-row sections.
const KEYS = { newArrivals: 'new_arrivals', trending: 'trending' } as const;

export interface Featured {
  newArrivals: string;
  trending: string;
}

interface IndexDoc {
  dataSources?: Record<string, { params?: { handles?: string[] } }>;
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

function firstHandle(doc: IndexDoc | null, key: string): string {
  const h = doc?.dataSources?.[key]?.params?.handles;
  return Array.isArray(h) && typeof h[0] === 'string' ? h[0] : '';
}

// The collection handles the home's two featured rows currently bind to (from the theme draft).
export function readFeatured(files: ThemeFiles): Featured {
  const doc = parse(files[INDEX]);
  return {
    newArrivals: firstHandle(doc, KEYS.newArrivals),
    trending: firstHandle(doc, KEYS.trending),
  };
}

// Patch the home template so the featured rows bind to the chosen real collections. Defensive: if the
// template isn't the expected shape (a merchant may have edited it), or nothing is selected, the files
// are returned unchanged.
export function mapFeaturedCollections(files: ThemeFiles, sel: Partial<Featured>): ThemeFiles {
  const doc = parse(files[INDEX]);
  if (!doc?.dataSources) return files;
  let changed = false;
  for (const [key, handle] of [
    [KEYS.newArrivals, sel.newArrivals],
    [KEYS.trending, sel.trending],
  ] as const) {
    const params = doc.dataSources[key]?.params;
    if (handle && params) {
      params.handles = [handle];
      changed = true;
    }
  }
  return changed ? { ...files, [INDEX]: `${JSON.stringify(doc, null, 2)}\n` } : files;
}
