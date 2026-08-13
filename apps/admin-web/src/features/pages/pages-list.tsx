import { useEffect, useState } from 'react';
import type { Api, PbPageMeta, Store } from '../../common/api';
import { ApiError } from '../../common/api';
import { Icon, Spinner, useToast } from '../../common/ui';
import { NewPageDialog } from './new-page-dialog';
import { RowMenu } from './row-menu';
import { pageName, pageStatus } from './pagebuilder';

const statusPill = (p: PbPageMeta) => (!p.published ? 'pill' : 'pill pill-ok');

// The scaffolded template routes the storefront needs to render — never deletable.
const CORE_PATHS = new Set(['/', '/products/:handle', '/collections/:handle']);

const FILTERS: Record<string, (p: PbPageMeta) => boolean> = {
  All: () => true,
  Live: (p) => p.published,
  Draft: (p) => !p.published,
};

// Pages index: every storefront page in a table. Click a row to open the editor; "New page"
// creates one and jumps straight into it.
export function PagesList({
  api,
  store,
  onOpen,
}: {
  api: Api;
  store: Store;
  onOpen: (path: string, isNew: boolean, title?: string) => void;
}) {
  const toast = useToast();
  const [pages, setPages] = useState<PbPageMeta[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [tab, setTab] = useState('All');
  const [query, setQuery] = useState('');

  useEffect(() => {
    api
      .listPbPages(store.id)
      .then(setPages)
      .catch((e) => toast(e instanceof ApiError ? e.message : 'Failed to list pages', 'error'));
  }, [api, store.id, toast]);

  const list = pages ?? [];
  const q = query.trim().toLowerCase();
  const rows = list
    .filter(FILTERS[tab])
    .filter((p) => !q || `${pageName(p.path)} ${p.path}`.toLowerCase().includes(q));
  const tabs = Object.keys(FILTERS).map((label) => ({
    label,
    count: list.filter(FILTERS[label]).length,
  }));

  return (
    <>
      <div className="page-head">
        <div className="head-text">
          <h1>Pages</h1>
          <p>Every page on your storefront. Select one to edit its sections.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Icon.plus /> New page
        </button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {!pages ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div className="seg">
                {tabs.map((t) => (
                  <button
                    key={t.label}
                    className={t.label === tab ? 'on' : ''}
                    aria-pressed={t.label === tab}
                    onClick={() => setTab(t.label)}
                  >
                    {t.label}{' '}
                    <span style={{ color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {rows.length} of {pages.length} pages
              </span>
              <input
                className="input"
                style={{ width: 240, height: 34 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name or URL…"
                aria-label="Filter pages"
              />
            </div>
            <div className="table-wrap">
              <table className="data-table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Revision</th>
                    <th style={{ width: 56, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr
                      key={p.path}
                      onClick={() => onOpen(p.path, false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpen(p.path, false);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`Edit ${pageName(p.path)}`}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontWeight: 500 }}>{pageName(p.path)}</td>
                      <td className="mono" style={{ color: 'var(--muted)' }}>
                        {p.path}
                      </td>
                      <td>
                        <span className={statusPill(p)}>{pageStatus(p)}</span>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        Rev {p.published ? p.revision : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <RowMenu
                          label={`Actions for ${pageName(p.path)}`}
                          actions={[
                            {
                              label: 'Publish',
                              onClick: () => toast(`Publish ${pageName(p.path)} — demo only`),
                            },
                            {
                              label: 'Move to draft',
                              onClick: () => toast(`Move ${pageName(p.path)} to draft — demo only`),
                            },
                            {
                              label: 'Delete',
                              danger: true,
                              disabled: CORE_PATHS.has(p.path),
                              onClick: () => toast(`Delete ${pageName(p.path)} — demo only`),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        style={{ textAlign: 'center', color: 'var(--text-3)', padding: '22px' }}
                      >
                        {pages.length === 0
                          ? 'No pages yet — create your first one.'
                          : 'No pages match your filter.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {showNew && (
        <NewPageDialog
          existingPaths={(pages ?? []).map((p) => p.path)}
          onCreate={(path, title) => {
            setShowNew(false);
            onOpen(path, true, title);
          }}
          onClose={() => setShowNew(false)}
        />
      )}
    </>
  );
}
