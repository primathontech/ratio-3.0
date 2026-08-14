import { useMemo, useState } from 'react';
import { useToast } from '../../common/ui';
import { RowMenu } from '../../common/row-menu';

// UI-only drafts section for the Themes page — dummy data + the list/grid + publish flow, adapted from
// the reference themes-library UX. No API yet (one theme per store today); every action fires a toast.
type Draft = {
  id: string;
  name: string;
  meta: string;
  version: string;
  update: boolean;
  tone: string;
  ts: number;
};

const DUMMY_DRAFTS: Draft[] = [
  {
    id: 'd1',
    name: 'Ratio 3.0 — Holiday campaign',
    meta: 'Edited 5 minutes ago by Neha',
    version: '2.4.0',
    update: false,
    tone: 'var(--accent-weak)',
    ts: 5,
  },
  {
    id: 'd2',
    name: 'ratio-import-helium-pdp',
    meta: 'Imported Feb 1 at 11:13 am',
    version: '1.1.0',
    update: true,
    tone: 'var(--success-weak)',
    ts: 900,
  },
  {
    id: 'd3',
    name: 'Aurora',
    meta: 'Edited Jan 27 at 6:29 pm by Aarav',
    version: '3.0.0',
    update: true,
    tone: 'var(--surface-3)',
    ts: 1400,
  },
  {
    id: 'd4',
    name: 'Aurora — B2B pricing test',
    meta: 'Edited Jan 12 at 9:04 am by Sam',
    version: '2.2.0',
    update: false,
    tone: 'var(--surface-2)',
    ts: 2600,
  },
];
const THEME_SLOTS = 20;
const ROW_MENU = ['Preview', 'Rename', 'Duplicate', 'Download theme file', 'Delete'];

// A tiny wireframe thumbnail (dummy — drafts have no rendered preview).
function Thumb({ tone, w = 64, h = 44 }: { tone: string; w?: number; h?: number }) {
  return (
    <div className="draft-thumb" style={{ width: w, height: h }}>
      <span className="draft-thumb-bar" />
      <span className="draft-thumb-fill" style={{ background: tone }} />
      <span className="draft-thumb-feet">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function DraftActions({
  draft,
  onPublish,
  onMenu,
}: {
  draft: Draft;
  onPublish: () => void;
  onMenu: (item: string) => void;
}) {
  return (
    <div className="draft-actions">
      <button className="btn btn-ghost btn-sm" onClick={onPublish}>
        Publish
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => onMenu('Customize')}>
        Customize
      </button>
      <RowMenu
        actions={ROW_MENU.map((label) => ({
          label,
          danger: label === 'Delete',
          onClick: () => onMenu(`${label} · ${draft.name}`),
        }))}
      />
    </div>
  );
}

function DraftRow({
  draft,
  onPublish,
  onMenu,
}: {
  draft: Draft;
  onPublish: () => void;
  onMenu: (item: string) => void;
}) {
  return (
    <div className="draft-row">
      <Thumb tone={draft.tone} />
      <div className="draft-info">
        <div className="draft-name-line">
          <span className="draft-name">{draft.name}</span>
          {draft.update && <span className="draft-pill">Update</span>}
        </div>
        <span className="muted draft-meta">
          {draft.meta} · v{draft.version}
        </span>
      </div>
      <DraftActions draft={draft} onPublish={onPublish} onMenu={onMenu} />
    </div>
  );
}

function DraftCard({
  draft,
  onPublish,
  onMenu,
}: {
  draft: Draft;
  onPublish: () => void;
  onMenu: (item: string) => void;
}) {
  return (
    <div className="draft-card">
      <div className="draft-card-thumb">
        <span className="dct-bar" />
        <span className="dct-main" style={{ background: draft.tone }} />
        <span className="dct-feet">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="draft-card-body">
        <div className="draft-name-line">
          <span className="draft-name">{draft.name}</span>
          {draft.update && <span className="draft-pill">Update</span>}
        </div>
        <span className="muted draft-meta">
          {draft.meta} · v{draft.version}
        </span>
        <DraftActions draft={draft} onPublish={onPublish} onMenu={onMenu} />
      </div>
    </div>
  );
}

export function ThemeDrafts() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'Recent' | 'Name'>('Recent');
  const [view, setView] = useState<'List' | 'Grid'>('List');
  const [confirm, setConfirm] = useState<Draft | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? DUMMY_DRAFTS.filter((d) => d.name.toLowerCase().includes(q))
      : DUMMY_DRAFTS;
    return filtered
      .slice()
      .sort((a, b) => (sort === 'Name' ? a.name.localeCompare(b.name) : a.ts - b.ts));
  }, [query, sort]);

  const props = (d: Draft) => ({
    draft: d,
    onPublish: () => setConfirm(d),
    onMenu: (item: string) => toast(item, 'ok'),
  });

  return (
    <section className="drafts">
      <div className="drafts-head">
        <div className="drafts-head-left">
          <h2 className="drafts-title">Drafts</h2>
          <span className="muted drafts-count">
            {visible.length} of {DUMMY_DRAFTS.length} shown · {THEME_SLOTS} theme slots
          </span>
        </div>
        <div className="drafts-head-right">
          <input
            className="input drafts-filter"
            placeholder="Filter drafts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="seg">
            {(['Recent', 'Name'] as const).map((s) => (
              <button key={s} className={sort === s ? 'on' : ''} onClick={() => setSort(s)}>
                {s}
              </button>
            ))}
          </div>
          <div className="seg">
            {(['List', 'Grid'] as const).map((v) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="drafts-empty">
          <span>No drafts match this filter.</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setQuery('')}>
            Clear filter
          </button>
        </div>
      ) : view === 'List' ? (
        <div className="drafts-list">
          {visible.map((d) => (
            <DraftRow key={d.id} {...props(d)} />
          ))}
        </div>
      ) : (
        <div className="drafts-grid">
          {visible.map((d) => (
            <DraftCard key={d.id} {...props(d)} />
          ))}
        </div>
      )}

      {confirm && (
        <div className="draft-dialog-scrim" role="dialog" aria-modal="true">
          <div className="draft-dialog">
            <h3>Publish {confirm.name}?</h3>
            <p className="muted">
              It replaces your current live theme immediately. The current theme moves to drafts and
              can be republished anytime.
            </p>
            <div className="draft-dialog-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  toast(`${confirm.name} is now live`, 'ok');
                  setConfirm(null);
                }}
              >
                Publish theme
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
