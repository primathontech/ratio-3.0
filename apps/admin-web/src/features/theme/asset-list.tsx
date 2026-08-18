import { Icon } from '../../common/icons';
import type { ThemeAsset } from '../../common/api';
import { humanSize, isImageAsset } from './asset-helpers';

// Presentational grid of theme assets. Each tile shows a thumbnail (image types) or a generic file
// glyph (fonts), the path, a human size, a "Copy reference" action, and a delete with inline confirm.
// All state and the object-URL lifecycle live in the container.
export function AssetList({
  assets,
  thumbs,
  copiedPath,
  confirmDelete,
  onCopy,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  assets: ThemeAsset[];
  thumbs: Record<string, string>;
  copiedPath: string | null;
  confirmDelete: string | null;
  onCopy: (path: string) => void;
  onRequestDelete: (path: string) => void;
  onConfirmDelete: (path: string) => void;
  onCancelDelete: () => void;
}) {
  return (
    <ul className="asset-grid">
      {assets.map((a) => {
        const name = a.path.split('/').pop() ?? a.path;
        return (
          <li key={a.path} className="asset-item">
            <div className="asset-thumb">
              {isImageAsset(a.contentType) && thumbs[a.path] ? (
                <img src={thumbs[a.path]} alt={name} />
              ) : (
                <span className="asset-fileicon" aria-hidden="true">
                  <Icon.file size={22} />
                </span>
              )}
            </div>
            <div className="asset-meta">
              <span className="asset-path" title={a.path}>
                {a.path}
              </span>
              <span className="asset-size">{humanSize(a.size)}</span>
            </div>
            <div className="asset-actions">
              <button
                className="btn btn-sm"
                onClick={() => onCopy(a.path)}
                title="Copy the Liquid reference"
              >
                {copiedPath === a.path ? 'Copied' : 'Copy reference'}
              </button>
              {confirmDelete === a.path ? (
                <span className="row" style={{ gap: 2 }}>
                  <button
                    className="btn-icon danger"
                    aria-label={`Confirm delete ${a.path}`}
                    onClick={() => onConfirmDelete(a.path)}
                  >
                    <Icon.check size={14} />
                  </button>
                  <button className="btn-icon" aria-label="Cancel delete" onClick={onCancelDelete}>
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  className="btn-icon"
                  aria-label={`Delete ${a.path}`}
                  onClick={() => onRequestDelete(a.path)}
                >
                  <Icon.trash size={14} />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
