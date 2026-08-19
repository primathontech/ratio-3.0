import { useState } from 'react';
import type { Api, AssistantAction } from '../../common/api';
import { Spinner } from '../../common/ui';

const SUGGESTIONS = ['Show top products', 'Create a discount campaign', 'Forecast next week'];
// With no store open the assistant is in onboarding scope (create_store is available), so the
// example prompts guide the merchant to spin up their first store instead of asking about one.
const ONBOARD_SUGGESTIONS = [
  'Onboard a store called Acme, brand colour blue',
  'Create a store “Nova” at nova.in',
  'Set up a store and add an About page',
];

// The AI copilot rail. Reference "Ask Sophie" styling, but the chat drives our REAL assistant
// (api.assistant → the same control-plane the rest of the UI uses). With storeId === null the rail
// runs in onboarding mode and the example prompts guide the merchant to create their first store.
export function AskRatio({
  api,
  storeId,
  overlay,
  onChanged,
  onClose,
}: {
  api: Api;
  storeId: string | null;
  overlay?: boolean;
  onChanged: () => void;
  onClose?: () => void;
}) {
  const onboarding = storeId == null;
  type Turn = { role: 'you' | 'ai'; text: string; actions?: AssistantAction[] };
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setDraft('');
    setErr(null);
    setTurns((t) => [...t, { role: 'you', text }]);
    setBusy(true);
    try {
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
    <aside
      className="ask-rail"
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay || undefined}
      aria-label="Ask Ratio"
    >
      <div className="ask-head">
        <span className="ask-badge" aria-hidden>
          ✦
        </span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Ask Ratio</span>
        {onClose && (
          <button
            className="icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={onClose}
            aria-label="Close assistant"
          >
            ✕
          </button>
        )}
      </div>

      <div className="ask-body" aria-live="polite">
        {turns.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {onboarding
              ? 'Describe your store and I’ll set it up — e.g. “Onboard a store called Acme, brand colour blue, domain acme.in.” I can create the store, add pages, and connect your domain.'
              : 'Ask about your store — “Add an About page”, onboard a store, edit a theme. Changes go live immediately.'}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'you' ? 'chat you' : 'chat ai'}>
            {t.text}
            {t.actions && t.actions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {t.actions.map((a, j) => (
                  <span key={j} className={a.ok ? 'pill pill-ok' : 'pill pill-warn'}>
                    {a.tool} {a.ok ? 'done' : 'failed'}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {err && (
          <div className="note note-error" role="alert">
            {err}
          </div>
        )}
      </div>

      <div className="ask-foot">
        <div className="chips">
          {(onboarding ? ONBOARD_SUGGESTIONS : SUGGESTIONS).map((s) => (
            <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <input
            className="input"
            style={{ height: 36 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={onboarding ? 'Describe your new store…' : 'Ask about your store…'}
            disabled={busy}
            aria-label="Message"
          />
          <button
            className="btn btn-primary"
            type="submit"
            style={{ width: 36, padding: 0 }}
            disabled={busy || !draft.trim()}
            aria-label="Send"
          >
            {busy ? <Spinner /> : '↑'}
          </button>
        </form>
      </div>
    </aside>
  );
}
