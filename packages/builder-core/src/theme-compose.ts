// base ⊕ overrides (LLD Bucket E). A store's editable theme is a reference to an immutable BASE
// (a published library theme @version) plus the merchant's OVERRIDES — only the files they changed —
// so pulling a base update is a version bump, not a re-fork. The draft is stored as one overrides
// bundle; a `_deletes` entry inside it lists paths removed relative to the base. composeTheme
// flattens base ⊕ overrides into the full theme the compiler/renderer consumes; the render path is
// unaffected (it still loads the compiled composed bundle).
import type { ThemeFiles } from './bundle';

// Control key inside an overrides bundle: a JSON string[] of paths deleted relative to the base.
// Never a rendered theme file.
export const DELETES_MANIFEST = '_deletes';

export function composeTheme(base: ThemeFiles, overrides: ThemeFiles): ThemeFiles {
  const deletes = new Set(parseDeletes(overrides[DELETES_MANIFEST]));
  const out: ThemeFiles = {};
  for (const [path, content] of Object.entries(base)) {
    if (!deletes.has(path)) out[path] = content;
  }
  // Overrides applied AFTER deletes, so re-adding a deleted path (present in both) keeps the override.
  for (const [path, content] of Object.entries(overrides)) {
    if (path === DELETES_MANIFEST) continue;
    out[path] = content;
  }
  return out;
}

function parseDeletes(raw: string | undefined): string[] {
  if (raw == null) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return []; // a malformed manifest deletes nothing rather than throwing mid-render
  }
}
