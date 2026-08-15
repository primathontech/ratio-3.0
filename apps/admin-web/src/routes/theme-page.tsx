import { useNavigate, useParams } from 'react-router-dom';
import { ThemeSettingsPanel } from '../features/theme/theme-settings';
import { PageHeader } from '../common/page-header';
import { storeSlug, useMerchant } from '../common/store-context';

// Theme customize = brand settings (brand colour, typography, layout) for one theme, edited in that
// theme's draft and published via the bundle. Version history + code editing live behind "Edit code".
// Reached from the Themes list.
export function ThemePage() {
  const { api, store } = useMerchant();
  const navigate = useNavigate();
  const { themeId } = useParams();
  if (!themeId) return null;
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={`${store.name} theme`}
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
      <ThemeSettingsPanel api={api} store={store} themeId={themeId} />
    </div>
  );
}
