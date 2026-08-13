import { useState } from 'react';
import type { Api, AssistantAction } from './api';
import { Spinner } from './ui';

const SUGGESTIONS = ['Show top products', 'Create a discount campaign', 'Forecast next week'];

// The AI copilot rail. Reference "Ask Sophie" styling, but the chat drives our REAL assistant
// (api.assistant → the same control-plane the rest of the UI uses). The two insight cards are
// placeholder prompts; clicking them sends a real message.
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
  onClose: () => void;
}) {
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
        <button
          className="icon-btn"
          style={{ width: 26, height: 26 }}
          onClick={onClose}
          aria-label="Close assistant"
        >
          ✕
        </button>
      </div>

      <div className="ask-insights">
        <div className="insight">
          <div className="insight-kind" style={{ color: 'var(--success)' }}>
            Opportunity
          </div>
          <div style={{ fontSize: 13, lineHeight: '20px' }}>
            Revenue is up 12% — Instagram converts 2.1× your site average. Shift budget to Reels?
          </div>
          <button className="insight-act" onClick={() => send('Create a discount campaign')}>
            Draft the campaign →
          </button>
        </div>
        <div className="insight" style={{ background: 'var(--warning-weak)' }}>
          <div className="insight-kind" style={{ color: 'var(--warning)' }}>
            Risk
          </div>
          <div style={{ fontSize: 13, lineHeight: '20px' }}>
            Linen Shirt — Ecru sells out in 5 days. Supplier lead time is 11 days.
          </div>
          <button
            className="insight-act"
            onClick={() => send('Reorder 240 units of Linen Shirt — Ecru')}
          >
            Reorder 240 units →
          </button>
        </div>
      </div>

      <div className="ask-body" aria-live="polite">
        {turns.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
            Ask about your store — “Add an About page”, onboard a store, edit a theme. Changes go
            live immediately.
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
          {SUGGESTIONS.map((s) => (
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
            placeholder="Ask about your store…"
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
