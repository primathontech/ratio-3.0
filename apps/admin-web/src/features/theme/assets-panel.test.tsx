import { describe, test, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Api, ThemeAsset } from '../../common/api';
import { AssetList } from './asset-list';
import {
  ASSET_ACCEPT,
  assetPathFromFilename,
  assetReference,
  deleteAndList,
  humanSize,
  isImageAsset,
  mergeAssetsManifest,
  uploadAndList,
} from './asset-helpers';

const asset = (over: Partial<ThemeAsset> = {}): ThemeAsset => ({
  path: 'assets/logo.png',
  hash: 'h1',
  contentType: 'image/png',
  size: 12_600,
  ...over,
});

// A fake api carrying only the asset methods the panel uses. listAssets returns whatever we seed.
function fakeApi(list: ThemeAsset[]) {
  return {
    listAssets: vi.fn(async () => list),
    uploadAsset: vi.fn(async () => ({ ok: true, path: '', asset: {} as Omit<ThemeAsset, 'path'> })),
    deleteAsset: vi.fn(async () => ({ ok: true, path: '' })),
    getAssetBytes: vi.fn(async () => new Blob(['x'])),
  } as unknown as Api & {
    listAssets: ReturnType<typeof vi.fn>;
    uploadAsset: ReturnType<typeof vi.fn>;
    deleteAsset: ReturnType<typeof vi.fn>;
  };
}

describe('asset helpers', () => {
  test('assetReference builds the Liquid asset_url snippet', () => {
    expect(assetReference('assets/logo.png')).toBe("{{ 'assets/logo.png' | asset_url }}");
  });

  test('mergeAssetsManifest updates config/assets.json but keeps unsaved code edits', () => {
    // Editor buffer has an UNSAVED edit to a section; the freshly-read draft has a NEW asset manifest
    // (from an upload). The merge must take the manifest and leave the section edit intact.
    const buffer = {
      'sections/forma-hero.liquid': '<img src="{{ \'assets/hero.jpg\' | asset_url }}">', // unsaved edit
      'config/assets.json': '{"assets/old.png":{"hash":"a"}}',
    };
    const draft = {
      'sections/forma-hero.liquid': '<section>original</section>', // server's older section — must NOT win
      'config/assets.json': '{"assets/old.png":{"hash":"a"},"assets/hero.jpg":{"hash":"b"}}',
    };
    const merged = mergeAssetsManifest(buffer, draft);
    expect(merged['config/assets.json']).toBe(draft['config/assets.json']); // new manifest taken
    expect(merged['sections/forma-hero.liquid']).toBe(buffer['sections/forma-hero.liquid']); // edit kept
  });

  test('mergeAssetsManifest returns the buffer unchanged when the draft has no manifest', () => {
    const buffer = { 'sections/x.liquid': 'x' };
    expect(mergeAssetsManifest(buffer, {})).toEqual(buffer);
  });

  test('assetPathFromFilename defaults under assets/, drops any directory, and sanitizes', () => {
    expect(assetPathFromFilename('logo.png')).toBe('assets/logo.png');
    expect(assetPathFromFilename('C:\\pics\\hero.webp')).toBe('assets/hero.webp');
    // Spaces/parens/unicode → path-safe chars, so the server's ASSET_PATH_RE doesn't 400 the upload.
    expect(assetPathFromFilename('My Logo (1).png')).toBe('assets/My-Logo-1-.png');
    expect(assetPathFromFilename('café ☕.png')).toBe('assets/caf-.png');
  });

  test('humanSize renders bytes/KB/MB', () => {
    expect(humanSize(812)).toBe('812 B');
    expect(humanSize(12_600)).toBe('12.3 KB');
    expect(humanSize(1_500_000)).toBe('1.4 MB');
  });

  test('isImageAsset separates images from fonts', () => {
    expect(isImageAsset('image/png')).toBe(true);
    expect(isImageAsset('font/woff2')).toBe(false);
  });

  test('ASSET_ACCEPT allows the supported image + font types', () => {
    expect(ASSET_ACCEPT).toContain('image/png');
    expect(ASSET_ACCEPT).toContain('font/woff2');
  });
});

describe('AssetList (presentational)', () => {
  test('renders each asset path and human size from the list', () => {
    const assets = [
      asset(),
      asset({ path: 'assets/brand.woff2', contentType: 'font/woff2', size: 40_000 }),
    ];
    const html = renderToStaticMarkup(
      <AssetList
        assets={assets}
        thumbs={{}}
        copiedPath={null}
        confirmDelete={null}
        onCopy={() => {}}
        onRequestDelete={() => {}}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
      />
    );
    expect(html).toContain('assets/logo.png');
    expect(html).toContain('12.3 KB');
    expect(html).toContain('assets/brand.woff2');
    expect(html).toContain('Copy reference');
  });

  test('shows "Copied" feedback for the copied path only', () => {
    const html = renderToStaticMarkup(
      <AssetList
        assets={[asset()]}
        thumbs={{}}
        copiedPath="assets/logo.png"
        confirmDelete={null}
        onCopy={() => {}}
        onRequestDelete={() => {}}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
      />
    );
    expect(html).toContain('Copied');
    expect(html).not.toContain('Copy reference');
  });
});

describe('asset write-then-relist orchestration', () => {
  test('uploadAndList uploads then re-lists', async () => {
    const relisted = [asset(), asset({ path: 'assets/new.png' })];
    const api = fakeApi(relisted);
    const file = new File(['x'], 'new.png', { type: 'image/png' });

    const out = await uploadAndList(api, 'store1', 'theme1', 'assets/new.png', file);

    expect(api.uploadAsset).toHaveBeenCalledWith('store1', 'theme1', 'assets/new.png', file);
    expect(api.listAssets).toHaveBeenCalledWith('store1', 'theme1');
    expect(out).toBe(relisted);
    // The re-list happens after the upload resolves.
    expect(api.uploadAsset.mock.invocationCallOrder[0]).toBeLessThan(
      api.listAssets.mock.invocationCallOrder[0]
    );
  });

  test('deleteAndList deletes then re-lists', async () => {
    const relisted: ThemeAsset[] = [];
    const api = fakeApi(relisted);

    const out = await deleteAndList(api, 'store1', 'theme1', 'assets/logo.png');

    expect(api.deleteAsset).toHaveBeenCalledWith('store1', 'theme1', 'assets/logo.png');
    expect(api.listAssets).toHaveBeenCalledWith('store1', 'theme1');
    expect(out).toBe(relisted);
    expect(api.deleteAsset.mock.invocationCallOrder[0]).toBeLessThan(
      api.listAssets.mock.invocationCallOrder[0]
    );
  });
});
