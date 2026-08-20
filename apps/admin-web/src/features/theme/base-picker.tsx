import { useState } from 'react';
import type { BaseThemeOption } from '../../common/api';
import { PreviewFrame } from './preview-frame';
import './base-picker.css';

// Just the slice of the API client the picker needs — so callers pass their existing `api` object.
type PreviewApi = {
  previewBaseById: (baseId: string, page?: string) => Promise<{ html?: string; error?: string }>;
};

// The "start from" base chooser — selectable cards (name + description) with a live Preview of each
// base before adopting it (OFCE-700). Self-contained: it owns the preview modal so every caller
// (onboarding, new-theme dialog) gets preview for free. Renders nothing when there's only one base.
export function BasePicker({
  options,
  value,
  onChange,
  api,
}: {
  options: BaseThemeOption[];
  value: string;
  onChange: (id: string) => void;
  api: PreviewApi;
}) {
  const [preview, setPreview] = useState<BaseThemeOption | null>(null);
  const [html, setHtml] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  if (options.length <= 1) return null;

  async function openPreview(o: BaseThemeOption) {
    setPreview(o);
    setHtml('');
    setState('loading');
    try {
      const res = await api.previewBaseById(o.id);
      if (res.html) {
        setHtml(res.html);
        setState('ready');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  return (
    <>
      <div className="base-picker" role="radiogroup" aria-label="Start from">
        {options.map((o) => {
          const on = o.id === value;
          return (
            <div key={o.id} className={on ? 'base-opt on' : 'base-opt'}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                className="base-opt-pick"
                onClick={() => onChange(o.id)}
              >
                <span className="base-opt-name">{o.name}</span>
                <span className="base-opt-desc">{o.description}</span>
              </button>
              <button type="button" className="base-opt-preview" onClick={() => openPreview(o)}>
                Preview
              </button>
            </div>
          );
        })}
      </div>

      {preview && (
        <div
          className="base-preview-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview — ${preview.name}`}
          onClick={() => setPreview(null)}
        >
          <div className="base-preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="base-preview-head">
              <div className="base-preview-title">
                <strong>{preview.name}</strong>
                <span>{preview.description}</span>
              </div>
              <div className="base-preview-actions">
                <button
                  type="button"
                  className="base-preview-use"
                  onClick={() => {
                    onChange(preview.id);
                    setPreview(null);
                  }}
                >
                  Use this theme
                </button>
                <button
                  type="button"
                  className="base-preview-close"
                  aria-label="Close preview"
                  onClick={() => setPreview(null)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="base-preview-body">
              {state === 'loading' && <div className="base-preview-msg">Loading preview…</div>}
              {state === 'error' && (
                <div className="base-preview-msg">Couldn’t load this preview.</div>
              )}
              {state === 'ready' && (
                <PreviewFrame
                  html={html}
                  className="base-preview-frame"
                  title={`${preview.name} preview`}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
