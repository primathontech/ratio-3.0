import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ThemeSettingsPanel } from '../features/theme/theme-settings';
import { ThemeVersionsPanel } from '../features/theme/theme-versions-panel';
import { PageHeader } from '../common/page-header';
import { storeSlug, useMerchant } from '../common/store-context';

// Theme customize = brand settings + version history, as tabs (Versions is owner-only). Reached from
// the Themes list; "Edit code" launches the full-screen code editor (its own chrome-less route).
export function ThemePage() {
  const { api, store } = useMerchant();
  const navigate = useNavigate();
  const { themeId } = useParams();
  const owner = store.role === 'owner';
  const [tab, setTab] = useState<'settings' | 'versions'>('settings');
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {store.name} theme <span className="theme-pill">Live</span>
          </span>
        }
        description={
          store.host ? (
            <>
              Brand, typography and layout ·{' '}
              <a href={`https://${store.host}`} target="_blank" rel="noreferrer">
                {store.host} ↗
              </a>
            </>
          ) : (
            'Brand, typography and layout for your storefront.'
          )
        }
        onBack={() => navigate(`/stores/${storeSlug(store)}/themes`)}
        backLabel="Themes"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {store.host && (
            <a
              className="btn btn-ghost btn-sm"
              href={`https://${store.host}`}
              target="_blank"
              rel="noreferrer"
            >
              View store ↗
            </a>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              navigate(`/stores/${storeSlug(store)}/themes/${themeId}/editor`, {
                state: { fromApp: true },
              })
            }
          >
            Edit code
          </button>
        </div>
      </PageHeader>
      {/* Only owners have a second view (Versions), so the tab strip is owner-only — a member would
          otherwise see a lone, pointless "Settings" tab. */}
      {owner && (
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button
            className={tab === 'settings' ? 'on' : ''}
            aria-pressed={tab === 'settings'}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
          <button
            className={tab === 'versions' ? 'on' : ''}
            aria-pressed={tab === 'versions'}
            onClick={() => setTab('versions')}
          >
            Versions
          </button>
        </div>
      )}
      {tab === 'versions' && owner ? (
        <ThemeVersionsPanel api={api} store={store} />
      ) : (
        <ThemeSettingsPanel api={api} store={store} />
      )}
    </div>
  );
}
