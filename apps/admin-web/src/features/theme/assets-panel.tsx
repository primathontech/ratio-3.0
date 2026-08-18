import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type ThemeAsset } from '../../common/api';
import { Icon } from '../../common/icons';
import { Spinner, useToast } from '../../common/ui';
import { AssetList } from './asset-list';
import {
  ASSET_ACCEPT,
  assetPathFromFilename,
  assetReference,
  deleteAndList,
  isImageAsset,
  uploadAndList,
} from './asset-helpers';
import './assets-panel.css';

// The editor's Assets view (OFCE-632): manage a theme's binary assets — images and fonts the Liquid
// references. This is the container: it owns the list/loading/error/upload state and the thumbnail
// object-URL lifecycle, and renders the presentational <AssetList>. Binary assets are only ever
// managed here — they're never shown as editable text in the code editor.
export function AssetsPanel({
  storeId,
  themeId,
  api,
}: {
  storeId: string;
  themeId: string;
  api: Api;
}) {
  const toast = useToast();
  const [assets, setAssets] = useState<ThemeAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // A picked-but-not-yet-uploaded file and its (editable) target path — the confirm step.
  const [pending, setPending] = useState<File | null>(null);
  const [pendingPath, setPendingPath] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  // The object URLs currently backing the thumbnails, so we can revoke them on refresh/unmount.
  const urlsRef = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setAssets(await api.listAssets(storeId, themeId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load assets');
    } finally {
      setLoading(false);
    }
  }, [api, storeId, themeId]);
  useEffect(() => {
    void load();
  }, [load]);

  // Build thumbnails for image assets: an <img src> can't carry the bearer token, so we fetch each
  // asset's bytes and object-URL them. Revoke the previous batch first, and drop stale fetches when
  // the list changes again mid-flight, so no object URL ever leaks.
  useEffect(() => {
    let cancelled = false;
    Object.values(urlsRef.current).forEach(URL.revokeObjectURL);
    urlsRef.current = {};
    setThumbs({});
    for (const a of assets.filter((x) => isImageAsset(x.contentType))) {
      void api
        .getAssetBytes(storeId, themeId, a.path)
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urlsRef.current[a.path] = url;
          setThumbs((t) => ({ ...t, [a.path]: url }));
        })
        .catch(() => {
          // A missing thumbnail is non-fatal — the tile just falls back to the file glyph.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, api, storeId, themeId]);

  // Revoke every remaining object URL when the panel unmounts.
  useEffect(
    () => () => {
      Object.values(urlsRef.current).forEach(URL.revokeObjectURL);
    },
    []
  );

  function pickFile(file: File | null) {
    if (!file) return;
    setError('');
    setPending(file);
    setPendingPath(assetPathFromFilename(file.name));
  }

  function cancelUpload() {
    setPending(null);
    setPendingPath('');
    if (fileInput.current) fileInput.current.value = '';
  }

  async function confirmUpload() {
    const path = pendingPath.trim();
    if (!pending || !path) return;
    setUploading(true);
    setError('');
    try {
      setAssets(await uploadAndList(api, storeId, themeId, path, pending));
      cancelUpload();
    } catch (e) {
      // The server carries the reason (415 unsupported type, 413 too large, 409 conflict) — show it.
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function remove(path: string) {
    setConfirmDelete(null);
    setError('');
    try {
      setAssets(await deleteAndList(api, storeId, themeId, path));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the asset');
    }
  }

  async function copy(path: string) {
    try {
      await navigator.clipboard.writeText(assetReference(path));
      setCopiedPath(path);
      setTimeout(() => setCopiedPath((c) => (c === path ? null : c)), 1500);
    } catch {
      toast('Could not copy to the clipboard', 'error');
    }
  }

  return (
    <aside className="wb-sidebar wb-assets">
      <div className="wb-ws">
        <span className="wb-ws-name">Assets</span>
        <div className="wb-ws-actions">
          <button
            className="btn-icon"
            title="Refresh"
            aria-label="Refresh assets"
            onClick={() => void load()}
          >
            <Icon.refresh size={16} />
          </button>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ASSET_ACCEPT}
        className="asset-file-input"
        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
      />

      {pending ? (
        <div className="asset-upload">
          <label className="asset-upload-label">Save as</label>
          <input
            className="input asset-path-input"
            value={pendingPath}
            autoFocus
            onChange={(e) => setPendingPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmUpload();
              if (e.key === 'Escape') cancelUpload();
            }}
          />
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={cancelUpload} disabled={uploading}>
              Cancel
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void confirmUpload()}
              disabled={uploading || !pendingPath.trim()}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>
      ) : (
        <div className="asset-toolbar">
          <button className="btn btn-sm" onClick={() => fileInput.current?.click()}>
            <Icon.plus size={14} /> Upload asset
          </button>
        </div>
      )}

      {error && <div className="asset-error">{error}</div>}

      <div className="wb-assets-body">
        {loading ? (
          <div className="asset-center">
            <Spinner />
          </div>
        ) : assets.length === 0 ? (
          <p className="muted asset-empty">No assets yet — upload an image or font.</p>
        ) : (
          <AssetList
            assets={assets}
            thumbs={thumbs}
            copiedPath={copiedPath}
            confirmDelete={confirmDelete}
            onCopy={copy}
            onRequestDelete={setConfirmDelete}
            onConfirmDelete={remove}
            onCancelDelete={() => setConfirmDelete(null)}
          />
        )}
      </div>
    </aside>
  );
}
