import { useState } from 'react';
import { Dialog, Icon } from './ui';

// Popup to create a storefront page. Validates the path inline; the caller selects the new page
// once created. Title is optional — it defaults to empty and can be edited in the builder.
export function NewPageDialog({
  existingPaths,
  onCreate,
  onClose,
}: {
  existingPaths: string[];
  onCreate: (path: string, title: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState('/');
  const [title, setTitle] = useState('');

  const trimmed = path.trim();
  const norm = (p: string) => p.trim().toLowerCase().replace(/\/+$/, '') || '/';
  const badStart = trimmed.length > 0 && !trimmed.startsWith('/');
  const tooShort = trimmed === '/' || trimmed.length < 2;
  const duplicate = existingPaths.some((p) => norm(p) === norm(trimmed));
  const valid = !badStart && !tooShort && !duplicate;

  function submit() {
    if (!valid) return;
    onCreate(trimmed, title.trim());
  }

  return (
    <Dialog title="New page" onClose={onClose}>
      <label className="field" style={{ display: 'block', marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Path
        </span>
        <input
          className="input mono"
          placeholder="/about"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          aria-label="New page path"
          autoFocus
        />
        {badStart && (
          <span style={{ fontSize: 12, color: 'var(--danger)' }}>Path must start with /</span>
        )}
        {duplicate && (
          <span style={{ fontSize: 12, color: 'var(--danger)' }}>That page already exists</span>
        )}
      </label>
      <label className="field" style={{ display: 'block', marginBottom: 16 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Page title <span style={{ opacity: 0.6 }}>(optional)</span>
        </span>
        <input
          className="input"
          placeholder="About us"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!valid}>
          <Icon.plus size={14} /> Create page
        </button>
      </div>
    </Dialog>
  );
}
