import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Api, Store } from '../../common/api';
import { Spinner } from '../../common/ui';
import { storeSlug } from '../../common/store-context';
import './themes-list.css';

// The Themes landing: the store's live theme shown as a card with a rendered preview thumbnail (via
// the same preview endpoint the editor uses), a Live badge, and actions. One working theme per store
// today; the "Live theme" framing leaves room for a theme library below later.
export function ThemesList({ api, store }: { api: Api; store: Store }) {
  const navigate = useNavigate();
  const slug = storeSlug(store);
  // null = loading, '' = no preview / error, else the rendered HTML.
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewBundle(store.id) // no files → renders the saved theme's home page
      .then((r) => !cancelled && setThumb(r.error ? '' : (r.html ?? '')))
      .catch(() => !cancelled && setThumb(''));
    return () => {
      cancelled = true;
    };
  }, [api, store.id]);

  return (
    <div className="fade-in" style={{ maxWidth: 960 }}>
      <div className="page-head">
        <div className="head-text">
          <h1>Themes</h1>
          <p className="muted">
            Your storefront's themes — customize the settings or edit the code.
          </p>
        </div>
      </div>

      <h2 className="themes-section">Live theme</h2>
      <div className="theme-live card">
        <div className="theme-thumb">
          {thumb === null ? (
            <div className="theme-thumb-state">
              <Spinner />
            </div>
          ) : thumb ? (
            <iframe className="theme-thumb-frame" title="Theme preview" sandbox="" srcDoc={thumb} />
          ) : (
            <div className="theme-thumb-state muted">No preview yet</div>
          )}
          <span className="theme-live-badge">Live</span>
        </div>

        <div className="theme-live-body">
          <div>
            <strong className="theme-name">{store.name} theme</strong>
            <p className="muted theme-live-sub">
              This is what customers see. Edits go live when you publish.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={() => navigate(`/stores/${slug}/theme/settings`)}
            >
              Customize
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate(`/stores/${slug}/editor`)}
            >
              Edit code
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
