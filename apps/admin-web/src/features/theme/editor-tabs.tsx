// Presentational open-file tab strip. The active tab mirrors the container's `selected`, which the
// file tree also highlights, so the two stay in sync. The `previewTab` renders italic (VS Code's
// ephemeral tab); double-clicking a tab pins it (onPin).
export function EditorTabs({
  openTabs,
  selected,
  previewTab,
  onSelect,
  onClose,
  onPin,
}: {
  openTabs: string[];
  selected: string | null;
  previewTab: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onPin: (path: string) => void;
}) {
  if (openTabs.length === 0) return null;
  return (
    <div className="wb-tabs" role="tablist" aria-label="Open files">
      {openTabs.map((path) => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const isActive = path === selected;
        const isPreview = path === previewTab;
        const cls = ['wb-tab', isActive && 'active', isPreview && 'preview']
          .filter(Boolean)
          .join(' ');
        return (
          <div key={path} className={cls} onDoubleClick={() => onPin(path)}>
            <button
              className="wb-tab-name"
              role="tab"
              aria-selected={isActive}
              title={isPreview ? `${path} — double-click to keep open` : path}
              onClick={() => onSelect(path)}
            >
              {name}
            </button>
            <button
              className="wb-tab-close"
              aria-label={`Close ${name}`}
              onClick={() => onClose(path)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
