import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Api, Store } from '../../common/api';
import { Icon, Spinner, useToast } from '../../common/ui';
import { RowMenu } from '../../common/row-menu';
import { PageHeader } from '../../common/page-header';
import { storeSlug, storefrontUrl } from '../../common/store-context';
import { ThemeDrafts } from './theme-drafts';
import './themes-list.css';

// Dummy update + row menu (UI-only — actions fire a toast until the real theme-version API exists).
const LIVE_UPDATE = {
  version: '2.5.0',
  summary: 'accessibility fixes, faster cart drawer',
  changes: [
    'Cart drawer opens ~200ms faster on mobile.',
    'Focus rings and contrast fixes across product forms.',
    'New section: comparison table.',
  ],
};
const LIVE_MENU = ['Duplicate', 'Rename', 'Download theme file', 'Version history'];

type Preview = { status: 'loading' | 'ok' | 'empty'; html: string };

// A framed desktop preview: browser chrome (dots + domain) over the real rendered home page, scaled.
function DesktopPreview({ preview, domain }: { preview: Preview; domain: string }) {
  return (
    <div className="tp-desktop">
      <div className="tp-chrome">
        <span className="tp-dot" />
        <span className="tp-url">{domain}</span>
      </div>
      <div className="tp-desktop-body">
        {preview.status === 'loading' ? (
          <div className="tp-state">
            <Spinner />
          </div>
        ) : preview.status === 'ok' ? (
          <iframe
            className="tp-desktop-frame"
            title="Desktop preview"
            sandbox=""
            srcDoc={preview.html}
          />
        ) : (
          <div className="tp-state muted">No preview</div>
        )}
      </div>
    </div>
  );
}

// A phone-framed preview reusing the same rendered HTML.
function MobilePreview({ preview }: { preview: Preview }) {
  return (
    <div className="tp-mobile">
      {preview.status === 'ok' ? (
        <iframe
          className="tp-mobile-frame"
          title="Mobile preview"
          sandbox=""
          srcDoc={preview.html}
        />
      ) : (
        <div className="tp-state" />
      )}
    </div>
  );
}

// The Themes landing: the store's live theme as a rich card (two-device preview + details + actions),
// adapted from the reference themes-library UX. One working theme per store today.
export function ThemesList({ api, store }: { api: Api; store: Store }) {
  const navigate = useNavigate();
  const slug = storeSlug(store);
  const domain = store.host ?? slug;
  const live = storefrontUrl(store, false);
  const toast = useToast();
  const [preview, setPreview] = useState<Preview>({ status: 'loading', html: '' });
  const [showChanges, setShowChanges] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .previewBundle(store.id) // no files → renders the saved theme's home page
      .then((r) => {
        if (cancelled) return;
        const html = r.error ? '' : (r.html ?? '');
        setPreview({ status: html ? 'ok' : 'empty', html });
      })
      .catch(() => !cancelled && setPreview({ status: 'empty', html: '' }));
    return () => {
      cancelled = true;
    };
  }, [api, store.id]);

  return (
    <div className="fade-in">
      <PageHeader
        title="Themes"
        description={
          <>
            One theme is live on <span className="themes-domain">{domain}</span>. Customize it or
            edit the code.
          </>
        }
      >
        <button
          className="btn btn-ghost"
          onClick={() => toast('Import theme — pick a .zip or connect a repository', 'ok')}
        >
          Import theme
        </button>
        <button className="btn btn-primary" onClick={() => toast('Add theme — coming soon', 'ok')}>
          <Icon.plus /> Add theme
        </button>
      </PageHeader>

      <section className="theme-live">
        <div className="theme-live-preview">
          <DesktopPreview preview={preview} domain={domain} />
          <MobilePreview preview={preview} />
        </div>

        <div className="theme-live-body">
          <div className="theme-live-tag">
            <span className="themes-label">Live theme</span>
            <span className="theme-pill">Active</span>
          </div>

          <div>
            <h2 className="theme-name">{store.name} theme</h2>
            <p className="muted theme-live-sub">
              This is what customers see. Edits go live only when you publish.
            </p>
          </div>

          <div className="theme-update">
            <div className="theme-update-row">
              <span className="theme-update-dot" />
              <span className="muted theme-update-text">
                Version {LIVE_UPDATE.version} available — {LIVE_UPDATE.summary}
              </span>
              <button className="link-btn" onClick={() => setShowChanges((v) => !v)}>
                {showChanges ? 'Hide changes' : "What's new"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => toast('Update copied to a draft — review, then publish', 'ok')}
              >
                Update
              </button>
            </div>
            {showChanges && (
              <ul className="theme-update-changes">
                {LIVE_UPDATE.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="theme-live-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate(`/stores/${slug}/themes/${store.id}`)}
            >
              Customize
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(`/stores/${slug}/themes/${store.id}/editor`)}
            >
              Edit code
            </button>
            {live && (
              <a className="btn btn-ghost btn-sm" href={live} target="_blank" rel="noreferrer">
                View live <Icon.external />
              </a>
            )}
            <span style={{ flex: 1 }} />
            <RowMenu
              actions={LIVE_MENU.map((item) => ({ label: item, onClick: () => toast(item, 'ok') }))}
            />
          </div>
        </div>
      </section>

      <ThemeDrafts />
    </div>
  );
}
