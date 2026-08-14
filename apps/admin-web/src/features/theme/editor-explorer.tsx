import { Icon, FileIcon } from '../../common/icons';
import { type FileGroup } from './editor-helpers';

// Presentational Explorer sidebar: workspace header + actions, optional filter, the file tree (with
// per-file delete confirm), and the new-file input. All state and handlers live in the container.
export function EditorExplorer({
  storeName,
  groups,
  hasFiles,
  filter,
  showSearch,
  onFilterChange,
  collapsed,
  onFolderClick,
  selected,
  selectedFolder,
  targetFolder,
  onSelect,
  onNewFile,
  onRefresh,
  onCollapseAll,
  confirmDelete,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  adding,
  newPath,
  onNewPathChange,
  onAddCommit,
  onAddCancel,
}: {
  storeName: string;
  groups: FileGroup[];
  hasFiles: boolean;
  filter: string;
  showSearch: boolean;
  onFilterChange: (v: string) => void;
  collapsed: Set<string>;
  onFolderClick: (folder: string) => void;
  selected: string | null;
  selectedFolder: string | null;
  targetFolder: string | null;
  onSelect: (path: string) => void;
  onNewFile: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
  confirmDelete: string | null;
  onRequestDelete: (path: string) => void;
  onConfirmDelete: (path: string) => void;
  onCancelDelete: () => void;
  adding: boolean;
  newPath: string;
  onNewPathChange: (v: string) => void;
  onAddCommit: () => void;
  onAddCancel: () => void;
}) {
  const addInput = (placeholder: string) => (
    <input
      className="input tree-add-input"
      placeholder={placeholder}
      value={newPath}
      autoFocus
      onChange={(e) => onNewPathChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onAddCommit();
        if (e.key === 'Escape') onAddCancel();
      }}
      onBlur={onAddCommit}
    />
  );
  return (
    <aside className="wb-sidebar">
      <div className="wb-ws">
        <span className="wb-ws-name">{storeName}</span>
        <div className="wb-ws-actions">
          <button className="btn-icon" title="New file" aria-label="New file" onClick={onNewFile}>
            <Icon.newFile size={16} />
          </button>
          <button className="btn-icon" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
            <Icon.refresh size={16} />
          </button>
          <button
            className="btn-icon"
            title="Collapse folders"
            aria-label="Collapse folders"
            onClick={onCollapseAll}
          >
            <Icon.collapseAll size={16} />
          </button>
        </div>
      </div>

      {showSearch && (
        <input
          className="input wb-search"
          placeholder="Filter files…"
          value={filter}
          autoFocus
          onChange={(e) => onFilterChange(e.target.value)}
        />
      )}

      <div className="wb-tree">
        {!hasFiles ? (
          <div className="muted tree-empty">{filter ? 'No matches' : 'No files yet'}</div>
        ) : (
          <ul className="tree-list">
            {groups.map((g) => {
              const open = !collapsed.has(g.folder);
              return (
                <li key={g.folder || '/'}>
                  {g.folder && (
                    <button
                      className={g.folder === selectedFolder ? 'tree-folder active' : 'tree-folder'}
                      aria-expanded={open}
                      onClick={() => onFolderClick(g.folder)}
                    >
                      <span className={open ? 'caret' : 'caret collapsed'} aria-hidden="true">
                        <Icon.down size={14} />
                      </span>
                      {g.folder}
                    </button>
                  )}
                  {open && (
                    <ul className={g.folder ? 'tree-files nested' : 'tree-files'}>
                      {adding && targetFolder === g.folder && (
                        <li className="tree-add">{addInput('new.liquid')}</li>
                      )}
                      {g.files.map((f) => {
                        return (
                          <li
                            key={f.path}
                            className={f.path === selected && !selectedFolder ? 'active' : ''}
                          >
                            <button className="tree-item" onClick={() => onSelect(f.path)}>
                              <FileIcon path={f.path} />
                              {f.name}
                            </button>
                            {confirmDelete === f.path ? (
                              <span className="row" style={{ gap: 2 }}>
                                <button
                                  className="btn-icon danger"
                                  aria-label={`Confirm delete ${f.path}`}
                                  onClick={() => onConfirmDelete(f.path)}
                                >
                                  <Icon.check size={14} />
                                </button>
                                <button
                                  className="btn-icon"
                                  aria-label="Cancel delete"
                                  onClick={onCancelDelete}
                                >
                                  ✕
                                </button>
                              </span>
                            ) : (
                              <button
                                className="btn-icon"
                                aria-label={`Delete ${f.path}`}
                                onClick={() => onRequestDelete(f.path)}
                              >
                                <Icon.trash size={14} />
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {adding && targetFolder === null && (
          <div className="wb-add">{addInput('sections/new.liquid')}</div>
        )}
      </div>
    </aside>
  );
}
