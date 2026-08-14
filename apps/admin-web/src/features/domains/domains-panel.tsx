import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Store, DomainInfo, DomainConnection } from '../../common/api';
import { Dialog, Field, Icon, Spinner, useToast } from '../../common/ui';

// Screen-reader-only cue for links that open a new tab (L4 / WCAG G201).
const NewTabHint = () => <span className="sr-only"> (opens in a new tab)</span>;

export function DomainsPanel({ api, store }: { api: Api; store: Store }) {
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
