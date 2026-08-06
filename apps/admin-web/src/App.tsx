import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from '@clerk/clerk-react';
import {
  createApi,
  type Api,
  type Store,
  type DomainInfo,
  type DomainConnection,
  type AuditEntry,
  type AssistantAction,
} from './api';
import { useTheme } from './theme';
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorBoundary,
  Field,
  Icon,
  Spinner,
  ToastProvider,
  useToast,
} from './ui';
import { PageBuilderPanel } from './pagebuilder';
import { ThemeSettingsPanel } from './theme-settings';

const API_URL = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:8787';

// Screen-reader-only cue for links that open a new tab (L4 / WCAG G201).
const NewTabHint = () => <span className="sr-only"> (opens in a new tab)</span>;

export function App() {
  const { resolved, cycle } = useTheme();
  return (
    <ToastProvider>
      <header className="appbar">
        <a className="brand" href="/">
          <span className="logo">R</span> Ratio Admin
        </a>
        <div className="right">
          <button
            className="icon-btn"
            onClick={cycle}
            aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
            title="Toggle theme"
          >
            {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
          </button>
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </header>

      <SignedOut>
        <main className="signin-wrap">
          <div className="signin-card">
            <div style={{ textAlign: 'center' }}>
              <h1>Manage your store</h1>
              <p className="muted tagline">
                Sign in to edit your storefront — pages go live the moment you save.
              </p>
            </div>
            <SignIn routing="hash" />
          </div>
        </main>
      </SignedOut>

      <SignedIn>
        <ErrorBoundary>
          <Dashboard />
        </ErrorBoundary>
      </SignedIn>
    </ToastProvider>
  );
}

function useApi(): Api {
  const { getToken } = useAuth();
  return useMemo(() => createApi(API_URL, () => getToken()), [getToken]);
}

function Dashboard() {
  const api = useApi();
  const [store, setStore] = useState<Store | null>(null);
  // Bumped after the AI assistant makes a change, so the active view remounts and reloads.
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <main className="container">
      {store ? (
        // No key here (M2): remounting the open editor on an assistant change discarded the
        // merchant's unsaved edits. The editor keeps its state; a stale save is caught by the
        // page's optimistic-concurrency version check (409 → "reload").
        <PageManager api={api} store={store} onBack={() => setStore(null)} />
      ) : (
        <StoreList key={reloadKey} api={api} onOpen={setStore} />
      )}
      <AssistantPanel
        api={api}
        storeId={store?.id ?? null}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
    </main>
  );
}

// OFCE-400 Model A: chat with the AI assistant right in the dashboard. It drives the same
// control-plane the rest of this UI does (server-side), so anything it does — onboard a
// store, add a page — is real and shows up in "Recent changes". Available whether or not a
// store is open; when one is open its id is passed so "add a page" needs no repetition.
function AssistantPanel({
  api,
  storeId,
  onChanged,
}: {
  api: Api;
  storeId: string | null;
  onChanged: () => void;
}) {
  type Turn = { role: 'you' | 'ai'; text: string; actions?: AssistantAction[] };
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setErr(null);
    setTurns((t) => [...t, { role: 'you', text }]);
    setBusy(true);
    try {
      // No client key (R12 M-2): a fresh per-send UUID defeated the server's content-derived
      // dedup, so a resend after a client timeout re-ran the tool loop. Omitting it lets the
      // server key on (user, store, message) so an identical resend dedupes within the window.
      const r = await api.assistant(text, storeId ?? undefined);
      setTurns((t) => [...t, { role: 'ai', text: r.reply, actions: r.actions }]);
      if (r.actions.some((a) => a.ok)) onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pane" style={{ marginTop: 20 }}>
      <div className="pane-head">
        <h2>AI assistant</h2>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Ask in plain English — “Create a store called Acme at acme.ratiodev.in” or “Add an About
        page”. Changes go live immediately and appear in Recent changes.
      </p>

      {/* Always mounted (M6): a live region must exist before its content changes, or the
          first assistant reply isn't announced to screen readers. */}
      <div
        aria-live="polite"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          margin: turns.length ? '12px 0' : 0,
        }}
      >
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'you' ? 'note' : 'note note-ok'}>
            <strong>{t.role === 'you' ? 'You' : 'Assistant'}:</strong> {t.text}
            {t.actions && t.actions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {t.actions.map((a, j) => (
                  <span key={j} className={a.ok ? 'badge dot-ok' : 'badge dot-warn'}>
                    {a.tool} {a.ok ? 'done' : 'failed'}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}

      <form onSubmit={send} className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
        <Field label={storeId ? `Message (editing ${storeId})` : 'Message'}>
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the assistant to onboard or edit a store…"
            disabled={busy}
          />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? <Spinner /> : <Icon.check />} Send
        </button>
      </form>
    </div>
  );
}

/* Store list ------------------------------------------------------------- */
function StoreList({ api, onOpen }: { api: Api; onOpen: (s: Store) => void }) {
  const toast = useToast();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [me, setMe] = useState<{
    userId: string;
    isPlatformAdmin: boolean;
    isLocal?: boolean;
  } | null>(null);

  // Focus the heading when the list view (re)opens — e.g. returning via "All stores" — so
  // focus isn't dropped to <body> on the transition (M5 / WCAG 2.4.3).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const load = useCallback(() => {
    setError(null);
    api
      .listStores()
      .then(setStores)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    // Retry once so a transient /me failure doesn't silently strip the admin UI for the whole
    // session (L2); after that, degrade quietly to the non-admin view. Guarded against unmount.
    let cancelled = false;
    const loadMe = (attempt = 0) =>
      api
        .me()
        .then((m) => {
          if (!cancelled) setMe(m);
        })
        .catch(() => {
          if (!cancelled && attempt < 1) loadMe(attempt + 1);
        });
    loadMe();
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1
            ref={headingRef}
            tabIndex={-1}
            style={{ display: 'flex', alignItems: 'center', gap: 10, outline: 'none' }}
          >
            {me?.isPlatformAdmin ? 'All stores' : 'Your stores'}
            {me?.isPlatformAdmin && <Badge accent>Admin · all stores</Badge>}
          </h1>
          <p className="muted">
            {me?.isPlatformAdmin
              ? 'Platform admin — you can manage every store on Ratio.'
              : 'Every store is live at its own domain.'}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon.plus /> New store
        </button>
      </div>

      {error && (
        <div className="note note-error" role="alert">
          {error}
        </div>
      )}

      {!stores && !error && (
        <div className="grid" role="status" aria-busy="true">
          <span className="sr-only">Loading stores…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card store-card">
              <div className="skeleton" style={{ height: 34, width: 34, borderRadius: 9 }} />
              <div className="skeleton" style={{ height: 14, width: '70%' }} />
              <div className="skeleton" style={{ height: 12, width: '55%' }} />
            </div>
          ))}
        </div>
      )}

      {stores && stores.length === 0 && (
        <EmptyState emoji="🏪" title="No stores yet">
          <p className="muted" style={{ maxWidth: 320 }}>
            Create your first store — it goes live instantly at its own subdomain.
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon.plus /> Create a store
          </button>
        </EmptyState>
      )}

      {stores && stores.length > 0 && (
        <div className="grid">
          {stores.map((s) => (
            <StoreCard key={s.id} store={s} onOpen={() => onOpen(s)} local={!!me?.isLocal} />
          ))}
        </div>
      )}

      {creating && (
        <CreateStoreDialog
          api={api}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            toast('Store created');
            load();
          }}
        />
      )}

      {me && (
        <p className="muted" style={{ marginTop: 32, fontSize: 12.5 }}>
          Signed in · <span className="mono">{me.userId}</span>
        </p>
      )}
    </>
  );
}

// Tolerate the deploy-skew window where the API hasn't shipped `hosts` yet.
function hostsOf(store: Store): string[] {
  return store.hosts ?? (store.host ? [store.host] : []);
}

function StoreCard({ store, onOpen, local }: { store: Store; onOpen: () => void; local: boolean }) {
  const hosts = hostsOf(store);
  // *.localhost is the dev alias (added at onboard when RATIO_LOCAL); the real domains are the rest.
  const prodHosts = hosts.filter((h) => !h.endsWith('.localhost'));
  const localHost = hosts.find((h) => h.endsWith('.localhost'));
  return (
    <div className="card store-card">
      <div className="top">
        <div>
          {/* The store name is the primary action (a real button — keyboard/SR correct);
              host links are siblings, not nested inside an interactive element (M-2/L-4). */}
          <button type="button" className="name store-open" onClick={onOpen}>
            {store.name}
          </button>
          {prodHosts.length > 0 ? (
            <div className="hosts">
              {prodHosts.map((h) => (
                <a key={h} className="host" href={`https://${h}`} target="_blank" rel="noreferrer">
                  {h} <Icon.external size={11} />
                  <NewTabHint />
                </a>
              ))}
            </div>
          ) : (
            <span className="host muted">no domain</span>
          )}
          {/* Dev-only (RATIO_LOCAL, from /me): link to the storefront at its *.localhost host, which
              resolves to 127.0.0.1 and — being a host, not a query param — survives navigation. */}
          {local && localHost && (
            <div className="hosts">
              <a
                className="host"
                href={`http://${localHost}:8080/`}
                target="_blank"
                rel="noreferrer"
              >
                {localHost}:8080 <Icon.external size={11} />
                <NewTabHint />
              </a>
            </div>
          )}
        </div>
      </div>
      <div className="foot">
        <Badge accent>{store.role}</Badge>
        <span className="mono muted" style={{ fontSize: 12 }}>
          {store.id}
        </span>
      </div>
    </div>
  );
}

function CreateStoreDialog({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [f, setF] = useState({ name: '', host: '', color: '#4f46e5', merchantId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createStore({ ...f, merchantId: f.merchantId.trim() || undefined });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Create a store" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="body">
          <Field label="Name">
            <input
              className="input"
              placeholder="Acme"
              value={f.name}
              onChange={set('name')}
              required
            />
          </Field>
          <Field label="Domain">
            <input
              className="input"
              placeholder="acme.ratiodev.in"
              value={f.host}
              onChange={set('host')}
              required
            />
          </Field>
          <Field
            label="Merchant ID (gokwik)"
            info="Connects live products from the commerce backend. Optional — leave blank for a store with no catalogue yet."
          >
            <input
              className="input mono"
              placeholder="196jdfqy1aot"
              value={f.merchantId}
              onChange={set('merchantId')}
            />
          </Field>
          <Field label="Accent colour">
            <input
              className="input"
              type="color"
              value={f.color}
              onChange={set('color')}
              style={{ height: 42, padding: 4 }}
            />
          </Field>
          {err && (
            <div className="note note-error" role="alert">
              {err}
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : <Icon.plus />} Create store
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* Page manager ----------------------------------------------------------- */
function PageManager({ api, store, onBack }: { api: Api; store: Store; onBack: () => void }) {
  const hosts = hostsOf(store);
  // Move focus to the store heading when this view opens so keyboard/SR users aren't dropped
  // to <body> on the transition (M5 / WCAG 2.4.3).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <>
      <button className="btn btn-subtle crumb" onClick={onBack}>
        <Icon.back size={15} /> All stores
      </button>
      <div className="page-head">
        <div>
          <h1 ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>
            {store.name}
          </h1>
          {hosts.length > 0 && (
            <p className="hosts">
              {hosts.map((h) => (
                <a key={h} href={`https://${h}`} target="_blank" rel="noreferrer">
                  {h} <Icon.external size={12} />
                  <NewTabHint />
                </a>
              ))}
            </p>
          )}
        </div>
      </div>

      <ThemeSettingsPanel api={api} store={store} />

      <PageBuilderPanel api={api} store={store} />

      <DomainsPanel api={api} store={store} />

      <AgentAccessPanel api={api} store={store} />

      <AuditPanel api={api} store={store} />
    </>
  );
}

// Bring-your-own-AI (ADR-007): mint a short-lived key scoped to this store and hand it to
// an AI assistant, which then drives the same control-plane API the dashboard uses.
function AgentAccessPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [key, setKey] = useState<{ token: string; scope: string[]; expiresIn: number } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      setKey(await api.mintAgentToken(store.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.token);
      toast('Access key copied');
    } catch {
      // Don't claim success when the copy failed (M3) — the token is shown only once.
      toast('Copy failed — select the key and copy it manually', 'error');
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>AI assistant access</h2>
        <button className="btn btn-ghost btn-sm" onClick={generate} disabled={busy}>
          {busy ? <Spinner /> : <Icon.plus size={14} />} Generate access key
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Give an AI assistant a key to edit <strong>this store only</strong>. It expires
        automatically. Anyone with the key can edit this store until it expires — share it
        carefully. Generating a new key does <strong>not</strong> disable an old one; each key stays
        valid until it expires.
      </p>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      {key && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Access key">
              <input
                className="input mono"
                readOnly
                value={key.token}
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <button type="button" className="btn btn-subtle" onClick={copy}>
              <Icon.check size={13} /> Copy
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Scope: <span className="mono">{key.scope.join(', ')}</span> · expires in{' '}
            {Math.round(key.expiresIn / 60)} min
          </p>
        </div>
      )}
    </div>
  );
}

// Recent control-plane changes for this store (ADR-016 audit trail) — makes AI/human edits
// visible and accountable. Every mutation is one row; "AI" = an agent-token actor.
function AuditPanel({ api, store }: { api: Api; store: Store }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    setErr(null);
    const seq = ++loadSeq.current; // latest-wins: a slow earlier load can't overwrite (M4)
    api
      .listAudit(store.id)
      .then((e) => {
        if (seq === loadSeq.current) setEntries(e);
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setErr(e.message);
      });
  }, [api, store.id]);
  useEffect(load, [load]);

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Recent changes</h2>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      {!entries && !err && (
        <div className="center-pad">
          <Spinner />
        </div>
      )}
      {entries && entries.length === 0 && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          No changes recorded yet — edits made here or by an AI assistant will show up.
        </p>
      )}
      {entries && entries.length > 0 && (
        <div className="domain-rows">
          {entries.map((e, i) => (
            <div className="domain-row" key={`${e.at}-${i}`}>
              <span className="mono">{e.action}</span>
              <span className="badge">{e.actorKind === 'agent' ? 'AI' : 'you'}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {new Date(e.at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DomainsPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [domains, setDomains] = useState<DomainInfo[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null); // host pending confirmation
  const [err, setErr] = useState<string | null>(null);

  // Distinguish a failed load from an empty list (OFCE-414): on error show the error, not
  // a misleading "no domains" state.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    setErr(null);
    const seq = ++loadSeq.current; // latest-wins (M4): a stale response can't re-add a removed domain
    api
      .listDomains(store.id)
      .then((d) => {
        if (seq === loadSeq.current) setDomains(d);
      })
      .catch((e: Error) => {
        if (seq !== loadSeq.current) return;
        setDomains([]);
        setErr(e.message);
      });
  }, [api, store.id]);
  useEffect(load, [load]);

  // Only claim success when the server actually confirms it, and surface real failures
  // (OFCE-414) — no more unconditional "Domain removed".
  async function remove(host: string) {
    setRemoving(null);
    setErr(null);
    try {
      const { removed } = await api.removeDomain(store.id, host);
      toast(removed ? 'Domain removed' : 'Domain was already removed');
      load();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not remove the domain', 'error');
    }
  }

  const statusBadge = (d: DomainInfo) => {
    if (d.kind === 'platform') return <span className="badge dot-ok">live</span>;
    if (d.status === 'active' && d.sslStatus === 'active')
      return <span className="badge dot-ok">live</span>;
    if (d.status === 'unconfigured') return <span className="badge">not configured</span>;
    return <span className="badge dot-warn">pending</span>;
  };

  return (
    <div className="card pane domains-panel">
      <div className="pane-head">
        <h2>Domains</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setConnecting(true)}>
          <Icon.plus size={14} /> Connect a domain
        </button>
      </div>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      {!domains && !err && (
        <div className="center-pad">
          <Spinner />
        </div>
      )}
      <div className="domain-rows">
        {domains?.map((d) => (
          <div className="domain-row" key={d.host}>
            <a className="mono" href={`https://${d.host}`} target="_blank" rel="noreferrer">
              {d.host}
              <NewTabHint />
            </a>
            <span className="badge">{d.kind === 'platform' ? 'Ratio subdomain' : 'custom'}</span>
            {statusBadge(d)}
            {d.kind === 'custom' && (
              <div className="domain-actions">
                <button className="btn btn-subtle btn-sm" onClick={() => setViewing(d.host)}>
                  View DNS records
                </button>
                <button
                  className="icon-btn"
                  aria-label="Remove domain"
                  onClick={() => setRemoving(d.host)}
                >
                  <Icon.trash size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {connecting && (
        <ConnectDomainDialog
          api={api}
          store={store}
          onClose={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            load();
          }}
        />
      )}
      {viewing && (
        <DomainRecordsDialog
          api={api}
          store={store}
          host={viewing}
          onClose={() => {
            setViewing(null);
            load();
          }}
        />
      )}
      {removing && (
        <Dialog title="Remove this domain?" onClose={() => setRemoving(null)}>
          <div className="body">
            <p>
              Remove <span className="mono">{removing}</span> from this store? The store will stop
              serving on it immediately until you reconnect it.
            </p>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={() => remove(removing)}>
              <Icon.trash size={14} /> Remove domain
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// Reused by the connect dialog and the "view records" dialog.
// Copy-to-clipboard button — DNS values (esp. long TXT tokens) are error-prone to hand-type.
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={`Copy ${label}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function DnsRecordsView({ result }: { result: DomainConnection }) {
  if (!result.records || result.records.length === 0) {
    return <div className="note">{result.note || result.error || 'Domain mapped.'}</div>;
  }
  const isApex = result.apex ?? (!!result.host && result.host.split('.').length <= 2);
  return (
    <>
      {isApex && (
        <div className="note note-warn dns-apex">
          <strong>Heads-up: {result.host} is a root (naked) domain.</strong>
          <span>
            Most domain providers (GoDaddy, Namecheap, …) can&apos;t point a root domain straight at
            us.
          </span>
          <span>
            <strong>Recommended:</strong> connect <span className="mono">www.{result.host}</span>{' '}
            instead, then set your root <span className="mono">{result.host}</span> to{' '}
            <em>forward / redirect</em> to <span className="mono">https://www.{result.host}</span>.
          </span>
          <span className="muted">
            Advanced: if your provider supports ALIAS/ANAME or CNAME-flattening (e.g. Cloudflare),
            you can use the routing record below at the root instead. Either way, the{' '}
            <span className="mono">TXT</span> records below still apply.
          </span>
        </div>
      )}
      <p className="dns-intro">
        Add these records at your domain provider for <span className="mono">{result.host}</span>.{' '}
        <em>Host/Name</em> is the part before your domain (the middle column) — use{' '}
        <strong>Copy</strong> so values paste in exactly.
      </p>
      <table className="dns-table">
        <colgroup>
          <col style={{ width: '62px' }} />
          <col />
          <col style={{ width: '42%' }} />
          <col style={{ width: '52px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Host / Name</th>
            <th scope="col">Value</th>
            <th scope="col">TTL</th>
          </tr>
        </thead>
        <tbody>
          {result.records.map((r, i) => (
            <Fragment key={i}>
              {r.purpose && (
                <tr className="dns-step-row">
                  <td className="dns-step" colSpan={4}>
                    {r.purpose}
                  </td>
                </tr>
              )}
              <tr className="dns-data-row">
                <td>
                  <span className="badge">{r.type}</span>
                </td>
                <td className="mono dns-host">
                  <span className="dns-cell">
                    <span className="dns-cell-text">{r.host}</span>
                    <CopyBtn text={r.host} label="host" />
                  </span>
                </td>
                <td className="mono dns-val">
                  <span className="dns-cell">
                    <span className="dns-cell-text">{r.value}</span>
                    <CopyBtn text={r.value} label="value" />
                  </span>
                </td>
                <td className="muted">{r.ttl}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DomainRecordsDialog({
  api,
  store,
  host,
  onClose,
}: {
  api: Api;
  store: Store;
  host: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<DomainConnection | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .getDomain(store.id, host)
      .then(setResult)
      .catch((e: Error) => setErr(e.message));
  }, [api, store.id, host]);
  return (
    <Dialog title={`DNS records — ${host}`} onClose={onClose} size="wide">
      <div className="body">
        {err && (
          <div className="note note-error" role="alert">
            {err}
          </div>
        )}
        {!result && !err && (
          <div className="center-pad">
            <Spinner />
          </div>
        )}
        {result && (
          <>
            {result.status && (
              <div
                className={
                  result.status === 'active' ? 'note note-ok dns-status' : 'note dns-status'
                }
              >
                {result.status === 'active'
                  ? '✓ Live — your domain is connected and serving.'
                  : 'Waiting on your DNS. Add the records below; once they propagate we verify ownership and issue the SSL certificate automatically — usually 5–30 minutes, occasionally a few hours.'}
              </div>
            )}
            <DnsRecordsView result={result} />
          </>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          <Icon.check /> Done
        </button>
      </div>
    </Dialog>
  );
}

function ConnectDomainDialog({
  api,
  store,
  onClose,
  onDone,
}: {
  api: Api;
  store: Store;
  onClose: () => void;
  onDone: () => void;
}) {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<DomainConnection | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.connectDomain(store.id, host.trim().toLowerCase()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Connect a custom domain" onClose={onClose}>
      {!result ? (
        <form onSubmit={submit}>
          <div className="body">
            <Field label="Your domain">
              <input
                className="input mono"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="shop.yourbrand.com"
                required
              />
            </Field>
            <p className="muted" style={{ fontSize: 12.5 }}>
              We'll issue an SSL certificate and give you the exact DNS records to add at your
              registrar.
            </p>
            {err && (
              <div className="note note-error" role="alert">
                {err}
              </div>
            )}
          </div>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner /> : <Icon.plus />} Connect
            </button>
          </div>
        </form>
      ) : (
        <div>
          <div className="body">
            <DnsRecordsView result={result} />
          </div>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onDone}>
              <Icon.check /> Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
