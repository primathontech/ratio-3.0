import { Icon } from '../../common/ui';
import { pageLabel } from './editor-helpers';

// The preview is ONE server-rendered page. Following a link/submitting a form would navigate the iframe
// to a real URL (e.g. /products/…) — which, in this sandbox, loads the SPA with scripts it can't run →
// a blank page. This guard neutralizes in-preview navigation (anchor clicks + form submits) so the
// preview stays put: it's a design preview, not a click-through storefront. It runs under
// sandbox="allow-scripts" WITHOUT allow-same-origin, so the theme's own scripts execute in an opaque,
// isolated origin (no access to the admin, its cookies, or same-origin network) — safe to run.
const PREVIEW_GUARD = `<script>(function(){
  function toEl(n){ while (n && n.nodeType !== 1) n = n.parentNode; return n; }
  document.addEventListener('click', function(e){
    var el = toEl(e.target); var a = el && el.closest ? el.closest('a[href]') : null;
    if (a) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopPropagation(); }, true);
})();</script>`;

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
          // allow-scripts (but NOT allow-same-origin) → theme JS runs isolated in an opaque origin; the
          // guard stops in-preview navigation so a link/button click can't blank the pane.
          sandbox="allow-scripts"
          srcDoc={previewHtml + PREVIEW_GUARD}
        />
      )}
    </div>
  );
}
