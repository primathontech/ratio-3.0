// Typed client for apps/admin-api. Attaches the Clerk session JWT as a bearer on
// every call. getToken + fetch are injected so this is unit-testable with no browser.

export type GetToken = () => Promise<string | null>;

export interface Store {
  id: string;
  name: string;
  role: string;
  host: string | null;
  hosts: string[];
  ownerId?: string | null; // the owner's clerk user id (platform-admin store↔user link)
  since?: string | null; // ISO — earliest membership (a real store "created"/age proxy)
}

// A registered user + the stores they belong to (platform-admin console). Memberships-derived —
// name/email aren't stored locally yet, so the UI labels a user by their store(s) and id.
export interface PlatformUser {
  userId: string;
  storeCount: number;
  joined: string; // ISO
  stores: { id: string; name: string; role: string }[];
  name?: string | null; // from Clerk; null when Clerk isn't configured or has no profile
  email?: string | null;
}

// Owner-level store powers (publish, set-live, rename, delete, danger). Platform admins get the
// synthetic role 'admin' from the API and hold these powers on every store — the backend's
// requireRole('owner') bypasses for them, so the UI must not hide the actions from them either.
export const canManageStore = (store: { role?: string }): boolean =>
  store.role === 'owner' || store.role === 'admin';
export interface StoreTheme {
  color?: string;
  bodyFont?: string;
  headingFont?: string;
  baseSize?: string;
  radius?: string;
  container?: string;
}
export interface ThemeVersion {
  version: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}
// One bundle theme in a store's library (OFCE-615). Several may exist; exactly one is live.
export interface ThemeSummary {
  id: string;
  name: string;
  isLive: boolean;
  liveVersion: number | null;
  latestVersion: number | null;
  createdAt: string;
}
// A "start from" base theme option shown in the create pickers (onboarding + new theme).
export interface BaseThemeOption {
  id: string;
  name: string;
  description: string;
}
// A bundle theme's files, keyed by path (e.g. 'index.liquid' → its source). The code editor's model.
export type ThemeFiles = Record<string, string>;
// --- Page builder (section/block PageDoc) ---
export interface PbSettingDef {
  key: string; // dotted path into section data, e.g. 'hero.heading'
  type: string; // text | url | richtext | range | number | select | color | boolean | image | ...
  label?: string;
  options?: string[];
  min?: number;
  max?: number;
}
export interface PbSectionDef {
  type: string;
  kind: string; // 'section' | 'block'
  settings: PbSettingDef[];
  blocks: string[];
  dataBinding?: string | null; // commerce data binding (e.g. 'grid', 'product') if data-backed
}
export interface PbBlock {
  id: string;
  type: string;
  data: Record<string, unknown>;
  version?: number;
}
export interface PbSection {
  id: string;
  type: string;
  data: Record<string, unknown>;
  blocks?: PbBlock[];
  version?: number;
  dataSourceKey?: string; // which page dataSource feeds this section
}
export interface PbDataSource {
  type: string;
  params?: Record<string, unknown>;
  options?: Record<string, unknown>;
  required?: boolean;
}
export interface PbDoc {
  path: string;
  title: string;
  sections: PbSection[];
  dataSources?: Record<string, PbDataSource>;
}
export interface PbCollection {
  handle: string;
  title: string;
}
export interface PbState {
  path: string;
  draft: PbDoc | null;
  live: PbDoc | null;
  revision: number;
  hasDraft: boolean;
}
export interface PbPageMeta {
  path: string;
  revision: number;
  published: boolean;
  hasDraft: boolean;
}

export interface DomainInfo {
  host: string;
  kind: 'platform' | 'custom';
  status: string;
  sslStatus: string;
}
export interface DnsRecord {
  type: string;
  name: string;
  host: string;
  value: string;
  ttl: string;
  purpose: string;
}
export interface DomainConnection {
  host: string;
  configured?: boolean;
  note?: string;
  error?: string;
  status?: string;
  sslStatus?: string;
  cnameTarget?: string;
  apex?: boolean;
  records?: DnsRecord[];
}

export interface AgentToken {
  token: string;
  scope: string[];
  expiresIn: number;
}

export interface AuditEntry {
  at: string;
  actor: string;
  actorKind: string;
  action: string;
  method: string;
  status: number;
}

export interface AssistantAction {
  tool: string;
  ok: boolean;
}
export interface AssistantReply {
  reply: string;
  actions: AssistantAction[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// The API returns errors as JSON ({ error } or { message }). Pull the human message out so callers
// show "that domain is already connected" — not the raw {"error":"…"} envelope. Falls back to the
// body as-is for a non-JSON error (e.g. a proxy 502 HTML page).
export function apiErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const m = j.error ?? j.message;
    if (typeof m === 'string' && m) return m;
  } catch {
    /* not JSON — use the raw body */
  }
  return body;
}

export interface ApiOptions {
  timeoutMs?: number; // abort a request that stalls, so the UI never hangs forever (M1)
  assistantTimeoutMs?: number; // the assistant runs a multi-step tool loop; it needs longer (R12 M-1)
}

// Pull a required array field out of a list response; a missing/renamed field is a
// malformed response, not an empty list — surface it as an error rather than letting the
// caller setState(undefined) and hang on its loading branch forever (M2).
function pickArray<T>(obj: unknown, key: string): T[] {
  const v = (obj as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(v)) throw new ApiError(0, `The server returned an unexpected response.`);
  return v as T[];
}

// The `?base=<id>` query the base-theme editor endpoints take (omitted → the platform Default base).
function baseQ(base?: string): string {
  return base ? `?base=${encodeURIComponent(base)}` : '';
}

// A binary theme asset as the editor's Assets view sees it: the path the theme references + the
// content address / type / size from the draft manifest (OFCE-632).
export interface ThemeAsset {
  path: string;
  hash: string;
  contentType: string;
  size: number;
}

// Base-theme propagation (OFCE-633). These mirror builder-core's base-propagation types — admin-web
// can't import @ratio/builder-core, so they're redeclared here and kept in sync by hand. Source of
// truth: packages/builder-core/src/theme/base-propagation.ts.
export type RebaseBlock = 'dirty-draft' | 'broken-layout';
export interface BaseRebaseTarget {
  tenantId: string;
  themeId: string;
  name: string; // the store's display name
  fromVersion: number; // base version it tracks today
  toVersion: number; // base version it would move to
  isLive: boolean;
  overrideCount: number;
  shadowedFiles: string[]; // base files it overrode, so the base change won't reach them
  blocked: RebaseBlock | null;
  error?: string;
}
export interface BaseRebasePlan {
  baseThemeId: string;
  latestVersion: number;
  targets: BaseRebaseTarget[];
}
export interface BaseRebaseOutcome {
  tenantId: string;
  themeId: string;
  ok: boolean;
  skipped?: boolean; // already current — nothing republished
  version?: number;
  madeLive?: boolean;
  error?: string;
  purgeError?: string;
}
export interface BaseThemeStatus {
  baseThemeId: string | null;
  latestVersion: number | null;
  storesBehind: number;
}

export function createApi(
  baseUrl: string,
  getToken: GetToken,
  fetchImpl: typeof fetch = fetch,
  opts: ApiOptions = {}
) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const assistantTimeoutMs = opts.assistantTimeoutMs ?? 90000;
  async function req<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutOverrideMs?: number
  ): Promise<T> {
    const token = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOverrideMs ?? timeoutMs);
    let res: Response;
    // A FormData body (asset upload) must NOT carry an explicit content-type — the browser sets the
    // multipart boundary itself; and it's sent as-is, not JSON-stringified.
    const isForm = body instanceof FormData;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: {
          ...(isForm ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // Timeout and network failures both land here — turn them into a clean, retryable
      // error instead of a rejected fetch the loaders would otherwise hang on (M1).
      const timedOut = (e as Error).name === 'AbortError';
      throw new ApiError(
        0,
        timedOut
          ? 'The request timed out. Please try again.'
          : 'Network error — check your connection and try again.'
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, apiErrorMessage(text) || res.statusText);
    }
    if (res.status === 204) return null as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError(res.status, 'The server returned an unexpected response.'); // I6
    }
  }

  return {
    me: () => req<{ userId: string; isPlatformAdmin: boolean; isLocal?: boolean }>('GET', '/me'),
    listStores: () =>
      req<Record<string, unknown>>('GET', '/stores').then((d) => pickArray<Store>(d, 'stores')),
    // Platform-admin only: every registered user + their stores.
    listUsers: () =>
      req<Record<string, unknown>>('GET', '/admin/users').then((d) =>
        pickArray<PlatformUser>(d, 'users')
      ),
    // Platform-admin only: base-theme propagation (OFCE-633). Status, dry-run plan, and apply-to-a-set.
    getBaseTheme: (baseThemeId?: string) =>
      req<BaseThemeStatus>(
        'GET',
        `/admin/base-theme${baseThemeId ? `?baseThemeId=${encodeURIComponent(baseThemeId)}` : ''}`
      ),
    previewBasePropagation: (body: { toVersion?: number; baseThemeId?: string } = {}) =>
      req<BaseRebasePlan>('POST', '/admin/base-theme/propagate/preview', body),
    applyBasePropagation: (targets: { tenantId: string; themeId: string }[], toVersion?: number) =>
      req<{ outcomes: BaseRebaseOutcome[] }>('POST', '/admin/base-theme/propagate/apply', {
        targets,
        toVersion,
      }),
    // Platform-admin only: edit a shared base theme (OFCE-656). Draft read/save, preview, publish
    // (a new base version), reset to the last published base. `base` picks which base (default =
    // the platform Default).
    getBaseThemeDraft: (base?: string) =>
      req<{ files: ThemeFiles; revision: string }>(
        'GET',
        `/admin/base-theme/edit/draft${baseQ(base)}`
      ),
    saveBaseThemeDraft: (files: ThemeFiles, revision: string, base?: string) =>
      req<{ ok: boolean; hash: string }>('PUT', `/admin/base-theme/edit/draft${baseQ(base)}`, {
        files,
        revision,
      }),
    previewBaseTheme: (files: ThemeFiles, page: string, base?: string) =>
      req<{ html?: string; sampleData?: boolean; error?: string }>(
        'POST',
        `/admin/base-theme/edit/preview${baseQ(base)}`,
        { files, page }
      ),
    publishBaseTheme: (base?: string) =>
      req<{ ok: boolean; version: number }>(
        'POST',
        `/admin/base-theme/edit/publish${baseQ(base)}`,
        {}
      ),
    resetBaseThemeDraft: (base?: string) =>
      req<{ ok: boolean; files: ThemeFiles; revision: string }>(
        'POST',
        `/admin/base-theme/edit/reset${baseQ(base)}`,
        {}
      ),
    createStore: (s: {
      name: string;
      host: string;
      color?: string;
      merchantId?: string;
      baseThemeId?: string;
    }) => req<{ id: string; url: string }>('POST', '/stores', s),
    // The "start from" base themes a new store/theme can adopt (name + description for the picker).
    listBaseThemes: () =>
      req<Record<string, unknown>>('GET', '/base-themes').then((d) =>
        pickArray<BaseThemeOption>(d, 'baseThemes')
      ),
    // Render a base theme to HTML (sample data) so the picker can preview it before adopting (OFCE-700).
    previewBaseById: (baseId: string, page = 'index') =>
      req<{ html?: string; error?: string }>(
        'GET',
        `/base-themes/${encodeURIComponent(baseId)}/preview?page=${encodeURIComponent(page)}`
      ),
    // Verify a commerce merchant id before a store exists (onboarding step 1). configured=false when
    // the backend isn't wired in this env; verified=true + collectionCount when the id reached it.
    verifyMerchant: (merchantId: string) =>
      req<{ configured: boolean; verified: boolean; collectionCount?: number }>(
        'POST',
        '/commerce/verify',
        { merchantId }
      ),
    deleteStore: (id: string) => req<unknown>('DELETE', `/stores/${id}`),
    getCommerce: (id: string) =>
      req<{ merchantId: string }>('GET', `/stores/${id}/commerce`).then((d) => d.merchantId ?? ''),
    saveCommerce: (id: string, merchantId: string) =>
      req<{ ok: boolean; merchantId: string; edgePurged?: boolean }>(
        'PUT',
        `/stores/${id}/commerce`,
        { merchantId }
      ),
    // --- Multi-theme library (OFCE-615): a store keeps several bundle themes; exactly one is live.
    listThemes: (id: string) =>
      req<Record<string, unknown>>('GET', `/stores/${id}/themes`).then((d) =>
        pickArray<ThemeSummary>(d, 'themes')
      ),
    // Create from a chosen base (default = the platform Default), or duplicate an existing theme.
    createTheme: (
      id: string,
      body: { name?: string; duplicateOf?: string; baseThemeId?: string } = {}
    ) => req<{ id: string }>('POST', `/stores/${id}/themes`, body),
    renameTheme: (id: string, themeId: string, name: string) =>
      req<{ ok: boolean }>('PATCH', `/stores/${id}/themes/${themeId}`, { name }),
    deleteTheme: (id: string, themeId: string) =>
      req<{ ok: boolean }>('DELETE', `/stores/${id}/themes/${themeId}`),
    // Set a theme live (owner-only). Omit `version` to activate its latest published version.
    activateTheme: (id: string, themeId: string, version?: number) =>
      req<{ version: number }>('POST', `/stores/${id}/themes/${themeId}/activate`, { version }),
    bundleVersions: (id: string, themeId: string) =>
      req<{ versions: ThemeVersion[]; liveVersion: number | null }>(
        'GET',
        `/stores/${id}/themes/${themeId}/versions`
      ),
    // Bundle-theme code authoring (OFCE-601): the merchant's Liquid/HTML/CSS files, distinct from the
    // token-based `theme*` methods above. Theme-scoped: the draft is that theme's working files
    // (base ⊕ overrides).
    getBundleDraft: (id: string, themeId: string) =>
      req<{ files: ThemeFiles; revision: string }>(
        'GET',
        `/stores/${id}/themes/${themeId}/draft`
      ).then((d) => ({ files: d.files ?? {}, revision: d.revision ?? '' })),
    // `revision` is the token last loaded; the server rejects the save (409) if another editor moved
    // the draft since, instead of silently clobbering. `hash` in the reply is the new revision.
    saveBundleDraft: (id: string, themeId: string, files: ThemeFiles, revision: string) =>
      req<{ ok: boolean; hash: string }>('PUT', `/stores/${id}/themes/${themeId}/draft`, {
        files,
        revision,
      }),
    scaffoldBundleDraft: (id: string, themeId: string) =>
      req<{ files: ThemeFiles; seeded: boolean; revision: string }>(
        'POST',
        `/stores/${id}/themes/${themeId}/scaffold`,
        {}
      ).then((d) => ({ files: d.files ?? {}, revision: d.revision ?? '' })),
    publishBundle: (id: string, themeId: string) =>
      req<{ ok: boolean; version: number }>('POST', `/stores/${id}/themes/${themeId}/publish`, {}),
    rollbackBundle: (id: string, themeId: string, version: number) =>
      req<{ ok: boolean; version: number }>('POST', `/stores/${id}/themes/${themeId}/rollback`, {
        version,
      }),
    // Reset the draft to pure base — drop every override (the merchant's customizations). Returns the
    // now-composed default files + fresh revision, unwrapped like getBundleDraft.
    resetBundleDraft: (id: string, themeId: string) =>
      req<{ ok: boolean; files: ThemeFiles; revision: string }>(
        'POST',
        `/stores/${id}/themes/${themeId}/reset`,
        {}
      ).then((d) => ({ files: d.files ?? {}, revision: d.revision ?? '' })),
    // Render a page of the theme to HTML for the live preview. Pass `files` to render the editor's
    // in-flight (possibly-unsaved) buffer; omit it to render the saved draft (base ⊕ overrides), e.g.
    // for a thumbnail. A template/Liquid error comes back as { error } rather than throwing.
    previewBundle: (id: string, themeId: string, files?: ThemeFiles, page = 'index') =>
      req<{ html?: string; error?: string }>('POST', `/stores/${id}/themes/${themeId}/preview`, {
        files,
        page,
      }),
    // Binary theme assets (OFCE-632). listAssets → the draft manifest entries; uploadAsset posts a File
    // as multipart (the browser sets the boundary); deleteAsset drops the manifest entry; getAssetBytes
    // fetches the raw bytes (auth'd) so the view can thumbnail an unpublished asset — an <img src> can't
    // carry the bearer token, so we fetch a Blob and the caller object-URLs it.
    listAssets: (id: string, themeId: string) =>
      req<{ assets: ThemeAsset[] }>('GET', `/stores/${id}/themes/${themeId}/assets`).then(
        (d) => d.assets ?? []
      ),
    uploadAsset: (id: string, themeId: string, path: string, file: File) => {
      const fd = new FormData();
      fd.append('path', path);
      fd.append('file', file);
      return req<{ ok: boolean; path: string; asset: Omit<ThemeAsset, 'path'> }>(
        'POST',
        `/stores/${id}/themes/${themeId}/assets`,
        fd,
        30_000 // assets are up to 5 MB — allow more than the 15s default
      );
    },
    deleteAsset: (id: string, themeId: string, path: string) =>
      req<{ ok: boolean; path: string }>(
        'DELETE',
        `/stores/${id}/themes/${themeId}/assets?path=${encodeURIComponent(path)}`
      ),
    getAssetBytes: async (id: string, themeId: string, path: string): Promise<Blob> => {
      const token = await getToken();
      const res = await fetchImpl(
        `${baseUrl}/stores/${id}/themes/${themeId}/assets/raw?path=${encodeURIComponent(path)}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} }
      );
      if (!res.ok)
        throw new ApiError(
          res.status,
          apiErrorMessage(await res.text().catch(() => '')) || res.statusText
        );
      return res.blob();
    },
    listDomains: (id: string) =>
      req<Record<string, unknown>>('GET', `/stores/${id}/domains`).then((d) =>
        pickArray<DomainInfo>(d, 'domains')
      ),
    connectDomain: (id: string, host: string) =>
      req<DomainConnection>('POST', `/stores/${id}/domains`, { host }),
    getDomain: (id: string, host: string) =>
      req<DomainConnection>('GET', `/stores/${id}/domain?host=${encodeURIComponent(host)}`),
    removeDomain: (id: string, host: string) =>
      req<{ removed: boolean }>('DELETE', `/stores/${id}/domains`, { host }),
    mintAgentToken: (id: string) => req<AgentToken>('POST', `/stores/${id}/agent-tokens`),
    listAudit: (id: string) =>
      req<Record<string, unknown>>('GET', `/stores/${id}/audit`).then((d) =>
        pickArray<AuditEntry>(d, 'entries')
      ),
    pbCatalog: () =>
      req<Record<string, unknown>>('GET', '/page-builder/catalog').then((d) =>
        pickArray<PbSectionDef>(d, 'sections')
      ),
    listPbPages: (id: string) =>
      req<Record<string, unknown>>('GET', `/stores/${id}/page-builder/pages`).then((d) =>
        pickArray<PbPageMeta>(d, 'pages')
      ),
    listCollections: (id: string) =>
      req<Record<string, unknown>>('GET', `/stores/${id}/collections`).then((d) =>
        pickArray<Record<string, unknown>>(d, 'collections').map((col) => ({
          handle: String(col.handle ?? ''),
          title: String(col.title ?? col.name ?? col.handle ?? ''),
        }))
      ),
    getPageBuilder: (id: string, path: string) =>
      req<PbState>('GET', `/stores/${id}/page-builder?path=${encodeURIComponent(path)}`),
    savePbDraft: (id: string, doc: PbDoc) =>
      req<{ ok: boolean; draft: PbDoc }>('PUT', `/stores/${id}/page-builder`, { doc }),
    publishPb: (id: string, path: string) =>
      req<{ ok: boolean; revision: number; edgePurged?: boolean }>(
        'POST',
        `/stores/${id}/page-builder/publish`,
        { path }
      ),
    assistant: (message: string, storeId?: string, idempotencyKey?: string) =>
      req<AssistantReply>(
        'POST',
        '/assistant',
        { message, storeId, idempotencyKey },
        assistantTimeoutMs
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
