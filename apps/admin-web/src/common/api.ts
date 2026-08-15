// Typed client for apps/admin-api. Attaches the Clerk session JWT as a bearer on
// every call. getToken + fetch are injected so this is unit-testable with no browser.

export type GetToken = () => Promise<string | null>;

export interface Store {
  id: string;
  name: string;
  role: string;
  host: string | null;
  hosts: string[];
}
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
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
      throw new ApiError(res.status, text || res.statusText);
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
    createStore: (s: { name: string; host: string; color?: string; merchantId?: string }) =>
      req<{ id: string; url: string }>('POST', '/stores', s),
    deleteStore: (id: string) => req<unknown>('DELETE', `/stores/${id}`),
    getCommerce: (id: string) =>
      req<{ merchantId: string }>('GET', `/stores/${id}/commerce`).then((d) => d.merchantId ?? ''),
    saveCommerce: (id: string, merchantId: string) =>
      req<{ ok: boolean; merchantId: string; edgePurged?: boolean }>(
        'PUT',
        `/stores/${id}/commerce`,
        { merchantId }
      ),
    getTheme: (id: string) =>
      req<{ theme: StoreTheme }>('GET', `/stores/${id}/theme`).then((d) => d.theme ?? {}),
    saveTheme: (id: string, theme: StoreTheme) =>
      req<{ ok: boolean; theme: StoreTheme; edgePurged?: boolean }>(
        'PUT',
        `/stores/${id}/theme`,
        theme
      ),
    themeVersions: (id: string) =>
      req<{ published: number | null; versions: ThemeVersion[] }>(
        'GET',
        `/stores/${id}/theme/versions`
      ),
    publishTheme: (id: string, note?: string, expectedBase?: number | null) =>
      req<{ ok: boolean; version: number; edgePurged?: boolean }>(
        'POST',
        `/stores/${id}/theme/publish`,
        { note, expectedBase }
      ),
    rollbackTheme: (id: string, version: number) =>
      req<{ ok: boolean; version: number; edgePurged?: boolean }>(
        'POST',
        `/stores/${id}/theme/rollback`,
        { version }
      ),
    // --- Multi-theme library (OFCE-615): a store keeps several bundle themes; exactly one is live.
    listThemes: (id: string) =>
      req<Record<string, unknown>>('GET', `/stores/${id}/themes`).then((d) =>
        pickArray<ThemeSummary>(d, 'themes')
      ),
    // Create from the shared Default base, or duplicate an existing theme's overrides.
    createTheme: (id: string, body: { name?: string; duplicateOf?: string } = {}) =>
      req<{ id: string }>('POST', `/stores/${id}/themes`, body),
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
