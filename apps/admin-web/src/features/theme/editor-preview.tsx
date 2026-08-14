import { Icon } from '../../common/ui';
import { pageLabel } from './editor-helpers';

// Presentational live-preview panel: a page picker + refresh over the server-rendered iframe.
export function EditorPreview({
  previewing,
  previewErr,
  previewHtml,
  previewPage,
  templatePages,
  onPageChange,
  onRefresh,
}: {
  previewing: boolean;
  previewErr: string;
  previewHtml: string;
  previewPage: string;
  templatePages: string[];
  onPageChange: (page: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="wb-preview">
      <div className="wb-preview-bar">
        <span className="muted">Preview{previewing ? ' · rendering…' : ''}</span>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <select
            className="wb-preview-page"
            aria-label="Preview page"
            value={previewPage}
            disabled={templatePages.length === 0}
            onChange={(e) => onPageChange(e.target.value)}
          >
            {templatePages.length === 0 ? (
              <option value="">No pages</option>
            ) : (
              templatePages.map((p) => (
                <option key={p} value={p}>
                  {pageLabel(p)}
                </option>
              ))
            )}
          </select>
          <button
            className="btn-icon"
            aria-label="Refresh preview"
            title="Refresh preview"
            onClick={onRefresh}
            disabled={previewing}
          >
            <Icon.refresh size={15} />
          </button>
        </div>
      </div>
      {previewErr ? (
        <div className="wb-preview-error">{previewErr}</div>
      ) : (
        <iframe
          className="wb-preview-frame"
          title="Theme preview"
          sandbox=""
          srcDoc={previewHtml}
        />
      )}
    </div>
  );
}
