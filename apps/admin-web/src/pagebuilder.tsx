// Page-builder editor: author section/block PageDocs (ADR-013), save a draft, publish live.
// Forms are generated from the section catalog the API returns, so adding a first-party section
// server-side surfaces here with no client change. Supports multiple pages per store and nested
// child blocks for sections that accept them (Shopify-shaped, one nesting level).
import { useCallback, useEffect, useState } from 'react';
import type {
  Api,
  PbSectionDef,
  PbSettingDef,
  PbSection,
  PbBlock,
  PbDoc,
  PbPageMeta,
  Store,
} from './api';
import { ApiError } from './api';
import { Icon, Spinner, Badge, useToast } from './ui';

function getPath(o: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((a, k) => {
    return a != null && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined;
  }, o);
}
function setPath(o: Record<string, unknown>, key: string, val: unknown): Record<string, unknown> {
  const keys = key.split('.');
  const root: Record<string, unknown> = { ...(o ?? {}) };
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...((cur[keys[i]] as Record<string, unknown>) ?? {}) };
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = val;
  return root;
}

let idSeq = 0;
const newId = (type: string) => `${type}-${Date.now().toString(36)}-${idSeq++}`;
const blankDoc = (path: string): PbDoc => ({ path, title: '', sections: [] });

function move<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function SettingInput({
  def,
  value,
  onChange,
}: {
  def: PbSettingDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = def.label ?? def.key;
  const str = typeof value === 'string' ? value : '';
  const common = { id: def.key, className: 'input' };
  let control;
  if (def.type === 'richtext') {
    control = (
      <textarea
        {...common}
        rows={3}
        value={str}
        onChange={(e) => onChange(e.target.value)}
        placeholder="<p>HTML allowed</p>"
      />
    );
  } else if (def.type === 'boolean') {
    control = (
      <input
        id={def.key}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else if (def.type === 'range' || def.type === 'number') {
    control = (
      <input
        {...common}
        type="number"
        min={def.min}
        max={def.max}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  } else if (def.type === 'select') {
    control = (
      <select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(def.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (def.type === 'color') {
    control = (
      <input
        id={def.key}
        type="color"
        value={str || '#000000'}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    control = (
      <input
        {...common}
        value={str}
        onChange={(e) => onChange(e.target.value)}
        placeholder={def.type}
      />
    );
  }
  return (
    <label className="field" style={{ display: 'block', marginBottom: 8 }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {label} <span style={{ opacity: 0.5 }}>({def.type})</span>
      </span>
      {control}
    </label>
  );
}

function SettingsForm({
  settings,
  data,
  onChange,
}: {
  settings: PbSettingDef[];
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}) {
  if (settings.length === 0) return <p className="muted">No editable fields.</p>;
  return (
    <>
      {settings.map((s) => (
        <SettingInput
          key={s.key}
          def={s}
          value={getPath(data, s.key)}
          onChange={(v) => onChange(setPath(data, s.key, v))}
        />
      ))}
    </>
  );
}

// Child-block editor for sections that accept blocks (e.g. slideshow → slide).
function BlocksEditor({
  section,
  def,
  defOf,
  onChange,
}: {
  section: PbSection;
  def: PbSectionDef;
  defOf: (type: string) => PbSectionDef | undefined;
  onChange: (blocks: PbBlock[]) => void;
}) {
  const blocks = (section.blocks as PbBlock[] | undefined) ?? [];
  const [addType, setAddType] = useState('');
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #ddd)', paddingTop: 10 }}>
      <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
        Blocks
      </span>
      {blocks.map((b, i) => (
        <div
          key={b.id}
          className="card"
          style={{ padding: 10, margin: '8px 0', background: 'var(--bg-subtle, #fafafa)' }}
        >
          <div className="pane-head" style={{ marginBottom: 6 }}>
            <span className="mono" style={{ fontSize: 12, textTransform: 'capitalize' }}>
              {b.type}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className="btn btn-ghost btn-sm"
                disabled={i === 0}
                onClick={() => onChange(move(blocks, i, -1))}
                aria-label="Move block up"
              >
                ↑
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={i === blocks.length - 1}
                onClick={() => onChange(move(blocks, i, 1))}
                aria-label="Move block down"
              >
                ↓
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onChange(blocks.filter((_, j) => j !== i))}
                aria-label="Delete block"
              >
                <Icon.trash size={13} />
              </button>
            </div>
          </div>
          <SettingsForm
            settings={defOf(b.type)?.settings ?? []}
            data={b.data}
            onChange={(data) => onChange(blocks.map((x, j) => (j === i ? { ...x, data } : x)))}
          />
        </div>
      ))}
      <div className="row" style={{ marginTop: 6, alignItems: 'flex-end', gap: 8 }}>
        <select
          className="input"
          value={addType}
          onChange={(e) => setAddType(e.target.value)}
          aria-label="Block type"
        >
          <option value="">Add a block…</option>
          {def.blocks.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          className="btn btn-ghost btn-sm"
          disabled={!addType}
          onClick={() => {
            if (!addType) return;
            onChange([...blocks, { id: newId(addType), type: addType, data: {} }]);
            setAddType('');
          }}
        >
          <Icon.plus size={13} /> Add
        </button>
      </div>
    </div>
  );
}

function SectionCard({
  section,
  def,
  defOf,
  index,
  count,
  onChange,
  onMove,
  onDelete,
}: {
  section: PbSection;
  def: PbSectionDef | undefined;
  defOf: (type: string) => PbSectionDef | undefined;
  index: number;
  count: number;
  onChange: (s: PbSection) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <div className="card pane" style={{ marginBottom: 10 }}>
      <div className="pane-head">
        <h3 style={{ margin: 0, textTransform: 'capitalize' }}>
          {section.type} <Badge>{section.id}</Badge>
        </h3>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label="Move down"
          >
            ↓
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onDelete} aria-label="Delete section">
            <Icon.trash size={14} />
          </button>
        </div>
      </div>
      {!def ? (
        <p className="muted">Unknown section type — not in the catalog.</p>
      ) : (
        <>
          <SettingsForm
            settings={def.settings}
            data={section.data}
            onChange={(data) => onChange({ ...section, data })}
          />
          {def.blocks.length > 0 && (
            <BlocksEditor
              section={section}
              def={def}
              defOf={defOf}
              onChange={(blocks) => onChange({ ...section, blocks } as PbSection)}
            />
          )}
        </>
      )}
    </div>
  );
}

export function PageBuilderPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<PbSectionDef[] | null>(null);
  const [pages, setPages] = useState<PbPageMeta[]>([]);
  const [path, setPath] = useState('/');
  const [doc, setDoc] = useState<PbDoc | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addType, setAddType] = useState('');
  const [newPath, setNewPath] = useState('');

  const err = useCallback(
    (e: unknown, fallback: string) => toast(e instanceof ApiError ? e.message : fallback, 'error'),
    [toast]
  );

  const loadPages = useCallback(() => {
    api
      .listPbPages(store.id)
      .then(setPages)
      .catch((e) => err(e, 'Failed to list pages'));
  }, [api, store.id, err]);

  const loadDoc = useCallback(
    async (p: string) => {
      const state = await api.getPageBuilder(store.id, p);
      setRevision(state.revision);
      setDoc(state.draft ?? state.live ?? blankDoc(p));
    },
    [api, store.id]
  );

  useEffect(() => {
    api
      .pbCatalog()
      .then(setCatalog)
      .catch((e) => err(e, 'Failed to load catalog'));
    loadPages();
    loadDoc('/').catch((e) => err(e, 'Failed to load page'));
  }, [api, loadPages, loadDoc, err]);

  const defOf = useCallback((type: string) => catalog?.find((c) => c.type === type), [catalog]);
  const sectionTypes = (catalog ?? []).filter((c) => c.kind === 'section');

  async function selectPage(p: string) {
    if (p === path) return;
    setPath(p);
    setDoc(null);
    await loadDoc(p).catch((e) => err(e, 'Failed to load page'));
  }
  function createPage() {
    const p = newPath.trim();
    if (!p.startsWith('/')) return toast('Path must start with /', 'error');
    if (pages.some((x) => x.path === p) || p === path)
      return toast('That page already exists', 'error');
    setNewPath('');
    setPath(p);
    setRevision(0);
    setDoc(blankDoc(p));
  }

  function patchSection(i: number, s: PbSection) {
    if (!doc) return;
    setDoc({ ...doc, sections: doc.sections.map((x, j) => (j === i ? s : x)) });
  }
  function addSection() {
    if (!doc || !addType) return;
    setDoc({
      ...doc,
      sections: [...doc.sections, { id: newId(addType), type: addType, data: {} }],
    });
    setAddType('');
  }

  async function saveDraft(): Promise<boolean> {
    if (!doc) return false;
    setBusy(true);
    try {
      await api.savePbDraft(store.id, doc);
      toast('Draft saved', 'ok');
      loadPages();
      return true;
    } catch (e) {
      err(e, 'Save failed');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!(await saveDraft())) return; // publish exactly what's on screen
    setBusy(true);
    try {
      const res = await api.publishPb(store.id, path);
      setRevision(res.revision);
      toast(`Published ${path} (revision ${res.revision})`, 'ok');
      loadPages();
    } catch (e) {
      err(e, 'Publish failed');
    } finally {
      setBusy(false);
    }
  }

  const knownPaths = pages.map((p) => p.path);
  const isNewPage = !knownPaths.includes(path);

  return (
    <div className="card pane" style={{ marginBottom: 18 }}>
      <div className="pane-head">
        <h2>
          Page builder{' '}
          <Badge accent>
            {path} · rev {revision}
          </Badge>
        </h2>
        {store.host && (
          <a
            className="btn btn-ghost btn-sm"
            href={`http://${store.host}:8080${path}`}
            target="_blank"
            rel="noreferrer"
          >
            View <Icon.external size={12} />
          </a>
        )}
      </div>

      {/* page switcher */}
      <nav className="pagelist" aria-label="Page-builder pages" style={{ marginBottom: 10 }}>
        {pages.map((p) => (
          <button
            key={p.path}
            className={p.path === path ? 'active' : ''}
            aria-current={p.path === path ? 'true' : undefined}
            onClick={() => selectPage(p.path)}
          >
            <span className="mono">{p.path}</span>
            <Badge>{p.published ? `rev ${p.revision}` : 'draft'}</Badge>
          </button>
        ))}
        {isNewPage && (
          <button className="active" aria-current="true">
            <span className="mono">{path}</span>
            <Badge>new</Badge>
          </button>
        )}
      </nav>
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-end', gap: 8 }}>
        <input
          className="input mono"
          placeholder="/new-page"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          aria-label="New page path"
        />
        <button className="btn btn-ghost btn-sm" onClick={createPage} disabled={!newPath.trim()}>
          <Icon.plus size={14} /> New page
        </button>
      </div>

      {!doc || !catalog ? (
        <div className="center-pad">
          <Spinner />
        </div>
      ) : (
        <>
          <label className="field" style={{ display: 'block', marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Page title
            </span>
            <input
              className="input"
              value={doc.title}
              onChange={(e) => setDoc({ ...doc, title: e.target.value })}
            />
          </label>

          {doc.sections.length === 0 && (
            <p className="muted" style={{ padding: '6px 2px' }}>
              No sections yet — add one below.
            </p>
          )}
          {doc.sections.map((s, i) => (
            <SectionCard
              key={s.id}
              section={s}
              def={defOf(s.type)}
              defOf={defOf}
              index={i}
              count={doc.sections.length}
              onChange={(ns) => patchSection(i, ns)}
              onMove={(dir) => setDoc({ ...doc, sections: move(doc.sections, i, dir) })}
              onDelete={() => setDoc({ ...doc, sections: doc.sections.filter((_, j) => j !== i) })}
            />
          ))}

          <div className="row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 8 }}>
            <select
              className="input"
              value={addType}
              onChange={(e) => setAddType(e.target.value)}
              aria-label="Section type"
            >
              <option value="">Add a section…</option>
              {sectionTypes.map((c) => (
                <option key={c.type} value={c.type}>
                  {c.type}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={addSection} disabled={!addType}>
              <Icon.plus size={14} /> Add
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={saveDraft} disabled={busy}>
              Save draft
            </button>
            <button className="btn btn-primary" onClick={publish} disabled={busy}>
              Publish
            </button>
          </div>
        </>
      )}
    </div>
  );
}
