import { useEffect, useRef, useState } from 'react';

export type Command = { label: string; group: string; run: () => void };

// ⌘K palette: filter a flat command list and run one. Enter runs the top match; Esc / backdrop
// closes. Purely presentational — the caller owns `open` and supplies the commands.
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      inputRef.current?.focus();
    }
  }, [open]);
  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const shown = needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
  const run = (c: Command) => {
    c.run();
    onClose();
  };

  return (
    <div
      className="cmdk"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <span style={{ color: 'var(--accent)' }} aria-hidden>
            ⌘
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to a section…"
            aria-label="Command"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) run(shown[0]);
              else if (e.key === 'Escape') onClose();
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-list">
          {shown.map((c, i) => (
            <button key={i} className="cmdk-item" onClick={() => run(c)}>
              <span style={{ flex: 1 }}>{c.label}</span>
              <span className="group">{c.group}</span>
            </button>
          ))}
          {shown.length === 0 && (
            <div style={{ padding: '22px 12px', textAlign: 'center', color: 'var(--text-3)' }}>
              No matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
