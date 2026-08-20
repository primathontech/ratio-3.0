import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Api, type BaseThemeOption, type ThemeFiles } from '../../common/api';
import { PageHeader } from '../../common/page-header';
import { Dialog, Icon, Spinner, useToast } from '../../common/ui';
import { CodeEditor } from '../theme/code-editor';
import { EditorPreview } from '../theme/editor-preview';
import '../theme/theme-editor.css';
import './base-theme-editor.css';

// Platform-admin editor for the shared BASE theme (OFCE-656). A focused editor over the /admin/base-theme
// /edit routes: pick a file, edit it (Monaco), preview a page with sample data, then Save (draft) and
// Publish (a new base version the propagation console rolls out to stores). This is the container — it
// owns all state and composes the presentational <CodeEditor/> + <EditorPreview/>.

// A 400 from save/publish comes back as a JSON `{ error, issues? }` body inside ApiError.message.
function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const b = JSON.parse(e.message) as {
        error?: string;
        issues?: { path: string; error: string }[];
      };
      if (b.issues?.length)
        return `Can't save — ${b.issues.map((i) => `${i.path} ${i.error}`).join('; ')}`;
      if (b.error) return b.error;
    } catch {
      /* not JSON */
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const realFiles = (f: ThemeFiles) =>
  Object.keys(f)
    .filter((k) => k !== '_deletes')
    .sort();

export function BaseThemeEditor({ api }: { api: Api }) {
  const toast = useToast();
  const [files, setFiles] = useState<ThemeFiles | null>(null);
  const [revision, setRevision] = useState('');
  const [selected, setSelected] = useState('layout/theme.liquid');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0); // bump to remount the editor (initial load / reset)
  const [confirmReset, setConfirmReset] = useState(false);
  // Which base is being edited. '' = the platform Default (the API defaults when no ?base= is sent);
  // the select shows bases[0] for it. Changing it reloads that base's draft (see `load` deps).
  const [bases, setBases] = useState<BaseThemeOption[]>([]);
  const [baseId, setBaseId] = useState('');

  useEffect(() => {
    api
      .listBaseThemes()
      .then(setBases)
      .catch(() => {});
  }, [api]);

  const [previewPage, setPreviewPage] = useState('index');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewErr, setPreviewErr] = useState('');
  const [previewing, setPreviewing] = useState(false);

  // Latest files without making runPreview depend on every keystroke.
  const filesRef = useRef<ThemeFiles>({});
  filesRef.current = files ?? {};

  const runPreview = useCallback(
    // `filesOverride` lets a caller pass just-loaded files instead of the ref, which only updates on the
    // next render — so the initial post-load preview doesn't fire with the stale (empty) ref.
    async (page: string, filesOverride?: ThemeFiles) => {
      setPreviewing(true);
      try {
        const r = await api.previewBaseTheme(filesOverride ?? filesRef.current, page, baseId);
        if (r.error) setPreviewErr(r.error);
        else {
          setPreviewHtml(r.html ?? '');
          setPreviewErr('');
        }
      } catch (e) {
        setPreviewErr(errorText(e));
      } finally {
        setPreviewing(false);
      }
    },
    [api, baseId]
  );

  const load = useCallback(() => {
    api
      .getBaseThemeDraft(baseId)
      .then((d) => {
        setFiles(d.files);
        setRevision(d.revision);
        setSelected((s) =>
          d.files[s] != null
            ? s
            : d.files['layout/theme.liquid'] != null
              ? 'layout/theme.liquid'
              : (realFiles(d.files)[0] ?? '')
        );
        setDirty(false);
        setReloadKey((k) => k + 1);
        void runPreview('index', d.files);
      })
      .catch((e) => setError(errorText(e)));
  }, [api, runPreview, baseId]);
  useEffect(load, [load]);

  const templatePages = useMemo(() => {
    const pages = realFiles(files ?? {})
      .filter((k) => k.startsWith('templates/') && k.endsWith('.json'))
      .map((k) => k.slice('templates/'.length, -'.json'.length));
    return pages.length ? pages : ['index'];
  }, [files]);

  function onEdit(value: string) {
    setFiles((f) => ({ ...(f ?? {}), [selected]: value }));
    setDirty(true);
  }

  async function save() {
    if (!files) return;
    setBusy(true);
    try {
      const res = await api.saveBaseThemeDraft(files, revision, baseId);
      setRevision(res.hash);
      setDirty(false);
      toast('Base draft saved', 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        toast('The base was edited elsewhere — reload before saving.', 'error');
      else toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (dirty) {
      toast('Save your changes before publishing.', 'error');
      return;
    }
    setBusy(true);
    try {
      const { version } = await api.publishBaseTheme(baseId);
      toast(`Published base v${version}. Use “Base theme” to roll it out to stores.`, 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    setBusy(true);
    try {
      const d = await api.resetBaseThemeDraft(baseId);
      setFiles(d.files);
      setRevision(d.revision);
      setDirty(false);
      setReloadKey((k) => k + 1);
      setConfirmReset(false);
      void runPreview(previewPage, d.files);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!files && !error) {
    return (
      <div className="center-pad">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Base theme"
        description="The theme every store starts from. Edit it, then publish a new base version and roll it out from the propagation view."
      >
        {bases.length > 1 && (
          <select
            className="input"
            style={{ width: 'auto' }}
            aria-label="Base theme to edit"
            value={baseId || bases[0]?.id || ''}
            onChange={(e) => {
              if (dirty) {
                toast('Save or reset your changes before switching base.', 'error');
                return;
              }
              setBaseId(e.target.value);
            }}
          >
            {bases.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
          Reset
        </button>
        <button className="btn btn-ghost" disabled={busy || !dirty} onClick={save}>
          {busy ? <Spinner /> : null} Save{dirty ? ' •' : ''}
        </button>
        <button className="btn btn-primary" disabled={busy || dirty} onClick={publish}>
          <Icon.up /> Publish version
        </button>
      </PageHeader>

      {error ? (
        <div className="note note-error" role="alert">
          {error}{' '}
          <button
            className="btn btn-sm"
            onClick={() => {
              setError(null);
              load();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="base-editor-grid">
          <div className="base-editor-code">
            <select
              className="input"
              style={{ marginBottom: 8 }}
              value={selected}
              aria-label="Base theme file"
              onChange={(e) => setSelected(e.target.value)}
            >
              {realFiles(files ?? {}).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {selected && (
              // Key only on reloadKey (initial load / reset): switching files changes `path`, letting
              // Monaco route between per-file models (preserving each file's cursor + undo), not remount.
              <CodeEditor
                key={reloadKey}
                path={selected}
                initialValue={(files ?? {})[selected] ?? ''}
                onChange={onEdit}
              />
            )}
          </div>
          <EditorPreview
            previewing={previewing}
            previewErr={previewErr}
            previewHtml={previewHtml}
            previewPage={previewPage}
            templatePages={templatePages}
            onPageChange={(p) => {
              setPreviewPage(p);
              void runPreview(p);
            }}
            onRefresh={() => void runPreview(previewPage)}
          />
        </div>
      )}

      {confirmReset && (
        <Dialog
          title="Discard base edits?"
          onClose={() => (busy ? undefined : setConfirmReset(false))}
        >
          <div className="body">
            This restores the base draft to the last published base version. Any unsaved and
            unpublished edits are lost.
          </div>
          <div className="actions">
            <button
              className="btn btn-ghost"
              onClick={() => setConfirmReset(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn btn-danger" onClick={doReset} disabled={busy}>
              {busy ? <Spinner /> : null} Discard edits
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
