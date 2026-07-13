// Typed client for services/admin-api. Attaches the Clerk session JWT as a bearer on
// every call. getToken + fetch are injected so this is unit-testable with no browser.

export type GetToken = () => Promise<string | null>;

export interface Store {
  id: string;
  name: string;
  role: string;
  host: string | null;
}
export interface PageSummary {
  path: string;
  page_type: string;
}
export interface Page {
  path: string;
  pageType: string;
  pageConfig: unknown;
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

export function createApi(baseUrl: string, getToken: GetToken, fetchImpl: typeof fetch = fetch) {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    const res = await fetchImpl(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || res.statusText);
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  return {
    listStores: () => req<{ stores: Store[] }>('GET', '/stores').then((d) => d.stores),
    createStore: (s: { id: string; name: string; host: string; color?: string }) =>
      req<{ id: string; url: string }>('POST', '/stores', s),
    deleteStore: (id: string) => req<unknown>('DELETE', `/stores/${id}`),
    listPages: (id: string) =>
      req<{ pages: PageSummary[] }>('GET', `/stores/${id}/pages`).then((d) => d.pages),
    getPage: (id: string, path: string) =>
      req<Page>('GET', `/stores/${id}/page?path=${encodeURIComponent(path)}`),
    savePage: (id: string, page: { path: string; pageType?: string; pageConfig: unknown }) =>
      req<Page>('PUT', `/stores/${id}/page`, page),
  };
}

export type Api = ReturnType<typeof createApi>;
