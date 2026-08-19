import type { ThemeFiles } from './bundle';
import { ASSET_MANIFEST_PATH, readAssetManifest } from './assets';

// One problem with a saved theme file: which path, and what's wrong.
export interface ThemeIssue {
  path: string;
  error: string;
}

const LAYOUT_PATH = 'layout/theme.liquid';
// The two slots the platform fills in every full-ownership layout. Tolerant of the `{{-`/`-}}` whitespace
// trims and inner spacing, so a merchant's own formatting doesn't trip a false positive.
const CONTENT_FOR_LAYOUT = /\{\{-?\s*content_for_layout\s*-?\}\}/;
const CONTENT_FOR_HEADER = /\{\{-?\s*content_for_header\s*-?\}\}/;

// Structural validation the editor runs at DRAFT-SAVE (OFCE-654): the merchant gets an error at save,
// not a broken store at publish. It rejects only UNAMBIGUOUS corruption — never legitimate work in
// progress:
//   - any `*.json` theme file must parse (a malformed manifest/template silently breaks rendering today);
//   - `config/assets.json` must be a well-formed asset manifest (no entry the loader would silently drop);
//   - `layout/theme.liquid` must keep the platform slots — `{{ content_for_layout }}` (the page body;
//     without it the theme renders blank) and `{{ content_for_header }}` (islands runtime / CSP / the
//     integration head).
// Liquid SYNTAX is deliberately NOT checked here — that needs the render isolate and already surfaces in
// the live preview and at publish; compiling every file on every keystroke-save would be far too costly.
export function validateThemeFiles(files: ThemeFiles): ThemeIssue[] {
  const issues: ThemeIssue[] = [];

  for (const [path, content] of Object.entries(files)) {
    if (path === '_deletes' || !path.endsWith('.json')) continue;
    try {
      JSON.parse(content);
    } catch {
      issues.push({ path, error: 'is not valid JSON' });
    }
  }

  // Manifest shape — only when it parsed (a parse failure is already reported above). readAssetManifest
  // keeps only well-formed entries, so any declared key it dropped is a malformed entry.
  const rawManifest = files[ASSET_MANIFEST_PATH];
  if (rawManifest != null && !issues.some((i) => i.path === ASSET_MANIFEST_PATH)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawManifest);
    } catch {
      /* already flagged as invalid JSON */
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (parsed !== null)
        issues.push({ path: ASSET_MANIFEST_PATH, error: 'must be a JSON object of asset entries' });
    } else {
      const clean = readAssetManifest(files);
      for (const key of Object.keys(parsed as Record<string, unknown>)) {
        if (!Object.hasOwn(clean, key))
          issues.push({
            path: ASSET_MANIFEST_PATH,
            error: `asset '${key}' is malformed (needs hash, contentType, size)`,
          });
      }
    }
  }

  const layout = files[LAYOUT_PATH];
  if (layout != null) {
    if (!CONTENT_FOR_LAYOUT.test(layout))
      issues.push({ path: LAYOUT_PATH, error: 'must include {{ content_for_layout }}' });
    if (!CONTENT_FOR_HEADER.test(layout))
      issues.push({ path: LAYOUT_PATH, error: 'must include {{ content_for_header }}' });
  }

  return issues;
}
