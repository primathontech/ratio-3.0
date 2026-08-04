// Page-builder editor: author a section/block PageDoc (ADR-013), save a draft, publish it live.
// Forms are generated from the section catalog the API returns, so adding a first-party section
// server-side surfaces here with no client change. v1 edits the home page ('/') and flat sections.
import { useCallback, useEffect, useState } from 'react';
import type { Api, PbSectionDef, PbSettingDef, PbSection, PbDoc, Store } from './api';
import { ApiError } from './api';
import { Icon, Spinner, Badge, useToast } from './ui';

const PATH = '/';

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

function SectionCard({
  section,
  def,
  index,
  count,
  onChange,
  onMove,
  onDelete,
}: {
  section: PbSection;
  def: PbSectionDef | undefined;
  index: number;
  count: number;
  onChange: (data: Record<string, unknown>) => void;
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
      {!def && <p className="muted">Unknown section type — not in the catalog.</p>}
      {def?.settings.length === 0 && <p className="muted">No editable fields.</p>}
      {def?.settings.map((s) => (
        <SettingInput
          key={s.key}
          def={s}
          value={getPath(section.data, s.key)}
          onChange={(v) => onChange(setPath(section.data, s.key, v))}
        />
      ))}
    </div>
  );
}

export function PageBuilderPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<PbSectionDef[] | null>(null);
  const [doc, setDoc] = useState<PbDoc | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addType, setAddType] = useState('');

  const load = useCallback(async () => {
    const [cat, state] = await Promise.all([api.pbCatalog(), api.getPageBuilder(store.id, PATH)]);
    setCatalog(cat);
    setRevision(state.revision);
    setDoc(state.draft ?? state.live ?? { path: PATH, title: store.name, sections: [] });
  }, [api, store.id, store.name]);

  useEffect(() => {
    load().catch((e) => toast(e instanceof ApiError ? e.message : 'Failed to load', 'error'));
  }, [load, toast]);

  const defOf = (type: string) => catalog?.find((c) => c.type === type);
  const sectionTypes = (catalog ?? []).filter((c) => c.kind === 'section');

  function patchSection(i: number, data: Record<string, unknown>) {
    if (!doc) return;
    setDoc({ ...doc, sections: doc.sections.map((s, j) => (j === i ? { ...s, data } : s)) });
  }
  function moveSection(i: number, dir: -1 | 1) {
    if (!doc) return;
    const next = [...doc.sections];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setDoc({ ...doc, sections: next });
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
      return true;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed';
      toast(msg, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!(await saveDraft())) return; // publish the exact thing on screen
    setBusy(true);
    try {
      const res = await api.publishPb(store.id, PATH);
      setRevision(res.revision);
      toast(`Published (revision ${res.revision})`, 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Publish failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pane" style={{ marginBottom: 18 }}>
      <div className="pane-head">
        <h2>
          Page builder <Badge accent>live rev {revision}</Badge>
        </h2>
        {store.host && (
          <a
            className="btn btn-ghost btn-sm"
            href={`http://${store.host}:8080`}
            target="_blank"
            rel="noreferrer"
          >
            View storefront <Icon.external size={12} />
          </a>
        )}
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
              index={i}
              count={doc.sections.length}
              onChange={(data) => patchSection(i, data)}
              onMove={(dir) => moveSection(i, dir)}
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
