// Pure helpers for the theme code editor's presentational pieces — no state, no React.

export type FileGroup = { folder: string; files: { path: string; name: string }[] };

// The canonical Shopify theme folders, always shown in the tree so the structure is familiar even
// before a folder has any files. (Only layout/sections/templates are wired into the render engine
// today; the rest are placeholders for future support.)
export const THEME_FOLDERS = [
  'assets',
  'blocks',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
];

// Group flat file paths into one level of folders (like a Shopify theme), with root-level files
// last. `alwaysShow` folders appear even when empty. One level covers real theme layouts.
export function groupByFolder(paths: string[], alwaysShow: string[] = []): FileGroup[] {
  const groups = new Map<string, { path: string; name: string }[]>();
  for (const folder of alwaysShow) groups.set(folder, []);
  for (const p of paths) {
    const slash = p.indexOf('/');
    const folder = slash === -1 ? '' : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    const list = groups.get(folder) ?? [];
    list.push({ path: p, name });
    groups.set(folder, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([folder, files]) => ({
      folder,
      files: files.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

// A friendly label for a preview target (a templates/<page>.json name).
export function pageLabel(page: string): string {
  if (page === 'index') return 'Home';
  if (page.startsWith('page.')) return `Page: ${page.slice(5)}`;
  return page.charAt(0).toUpperCase() + page.slice(1);
}

export function languageLabel(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      js: 'JavaScript',
      mjs: 'JavaScript',
      ts: 'TypeScript',
      json: 'JSON',
      css: 'CSS',
      liquid: 'Liquid',
      html: 'HTML',
    }[ext] ?? 'Plain Text'
  );
}
