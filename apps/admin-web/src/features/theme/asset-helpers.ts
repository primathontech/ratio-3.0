import type { Api, ThemeAsset } from '../../common/api';

// The file types the asset picker accepts — images the theme can reference plus web fonts. Kept in
// sync with the server's allow-list; an unsupported type still fails loudly with a 415 on upload.
export const ASSET_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/avif,image/x-icon,font/woff2';

// Default the asset's path to `assets/<filename>` from the picked file's name (dropping any path the
// browser handed us) and sanitizing to the server's allowed charset (ASSET_PATH_RE: word chars, dot,
// dash) so a name with spaces/parens/unicode doesn't 400 on upload. The user can still edit it.
export function assetPathFromFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  return `assets/${base || 'asset'}`;
}

// The Liquid reference a merchant pastes into their theme to use this asset.
export function assetReference(path: string): string {
  return `{{ '${path}' | asset_url }}`;
}

// Only image assets get a rendered thumbnail; fonts (and anything else) show a generic file icon.
export function isImageAsset(contentType: string): boolean {
  return contentType.startsWith('image/');
}

// A compact human size, e.g. "812 B", "12.3 KB", "1.4 MB".
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Upload an asset, then re-list so the view reflects the new manifest. The two-step flow lives here so
// the container stays thin and this exact "write then re-read" contract is testable in isolation.
export async function uploadAndList(
  api: Api,
  storeId: string,
  themeId: string,
  path: string,
  file: File
): Promise<ThemeAsset[]> {
  await api.uploadAsset(storeId, themeId, path, file);
  return api.listAssets(storeId, themeId);
}

// Delete an asset, then re-list.
export async function deleteAndList(
  api: Api,
  storeId: string,
  themeId: string,
  path: string
): Promise<ThemeAsset[]> {
  await api.deleteAsset(storeId, themeId, path);
  return api.listAssets(storeId, themeId);
}
