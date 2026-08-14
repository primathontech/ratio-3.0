import { Icon } from '../../common/ui';
import { ThemeToggle } from '../../common/theme-toggle';

// Presentational title bar: back + name on the left, preview/live/save/publish actions on the right.
// All behaviour lives in the ThemeCodeEditor container.
export function EditorTitleBar({
  storeName,
  dirty,
  ready,
  busy,
  showPreview,
  liveUrl,
  canPublish,
  onBack,
  onTogglePreview,
  onSaveDraft,
  onPublish,
}: {
  storeName: string;
  dirty: boolean;
  ready: boolean;
  busy: boolean;
  showPreview: boolean;
  liveUrl: string | null;
  canPublish: boolean;
  onBack?: () => void;
  onTogglePreview: () => void;
  onSaveDraft: () => void;
  onPublish: () => void;
}) {
  return (
    <div className="wb-titlebar">
      <div className="wb-title-left">
        {onBack && (
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <Icon.back /> Back
          </button>
        )}
        <span className="wb-title-name">
          {storeName} — Theme code {dirty && <span className="wb-dirty">●</span>}
        </span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <ThemeToggle className="btn btn-ghost btn-sm" />
        <button className="btn btn-ghost btn-sm" onClick={onTogglePreview} disabled={!ready}>
          {showPreview ? 'Hide preview' : 'Show preview'}
        </button>
        {liveUrl && (
          <a className="btn btn-ghost btn-sm" href={liveUrl} target="_blank" rel="noreferrer">
            View live <Icon.external />
          </a>
        )}
        <button className="btn btn-sm" onClick={onSaveDraft} disabled={busy || !dirty || !ready}>
          Save draft
        </button>
        {canPublish && (
          <button className="btn btn-primary btn-sm" onClick={onPublish} disabled={busy || !ready}>
            Publish
          </button>
        )}
      </div>
    </div>
  );
}
