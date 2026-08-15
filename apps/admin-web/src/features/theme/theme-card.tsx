import type { ThemeSummary } from '../../common/api';
import { Icon, Spinner } from '../../common/ui';
import { RowMenu } from '../../common/row-menu';

export type Preview = { status: 'loading' | 'ok' | 'empty'; html: string };

// A framed desktop preview: browser chrome (dot + domain) over the theme's real rendered home page,
// scaled down to a thumbnail.
function DesktopPreview({ preview, domain }: { preview: Preview; domain: string }) {
  return (
    <div className="tp-desktop">
      <div className="tp-chrome">
        <span className="tp-dot" />
        <span className="tp-url">{domain}</span>
      </div>
      <div className="tp-desktop-body">
        {preview.status === 'loading' ? (
          <div className="tp-state">
            <Spinner />
          </div>
        ) : preview.status === 'ok' ? (
          <iframe
            className="tp-desktop-frame"
            title="Theme preview"
            sandbox=""
            srcDoc={preview.html}
          />
        ) : (
          <div className="tp-state muted">No preview</div>
        )}
      </div>
    </div>
  );
}

// One theme in the library grid: a live thumbnail, name + status, and the per-theme actions. Pure —
// all state and endpoints live in the ThemesList container.
export function ThemeCard({
  theme,
  preview,
  domain,
  liveUrl,
  canManage,
  onEdit,
  onCustomize,
  onSetLive,
  onRename,
  onDuplicate,
  onDelete,
}: {
  theme: ThemeSummary;
  preview: Preview;
  domain: string;
  liveUrl: string | null;
  canManage: boolean;
  onEdit: () => void;
  onCustomize: () => void;
  onSetLive: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const published = theme.latestVersion != null;
  const menuActions = [
    { label: 'Rename', onClick: onRename },
    { label: 'Duplicate', onClick: onDuplicate },
    ...(canManage
      ? [{ label: 'Delete', danger: true, disabled: theme.isLive, onClick: onDelete }]
      : []),
  ];

  return (
    <div className="theme-card">
      <div className="theme-card-preview">
        <DesktopPreview preview={preview} domain={domain} />
      </div>
      <div className="theme-card-body">
        <div className="theme-card-titlerow">
          <span className="theme-card-name">{theme.name}</span>
          {theme.isLive && <span className="theme-badge">● Live</span>}
          <span style={{ flex: 1 }} />
          <RowMenu actions={menuActions} />
        </div>
        <span className="muted theme-card-meta">
          {published ? `Latest v${theme.latestVersion}` : 'Not published yet'}
        </span>
        <div className="theme-card-actions">
          <button className="btn btn-ghost btn-sm" onClick={onCustomize}>
            Customize
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>
            Edit code
          </button>
          {canManage && !theme.isLive && published && (
            <button className="btn btn-primary btn-sm" onClick={onSetLive}>
              Set as live
            </button>
          )}
          {theme.isLive && liveUrl && (
            <a className="btn btn-ghost btn-sm" href={liveUrl} target="_blank" rel="noreferrer">
              View live <Icon.external />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
