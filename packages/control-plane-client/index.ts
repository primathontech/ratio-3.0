// ADR-016 Phase 1 (OFCE-401): typed client for the Ratio control-plane API. Request/response
// shapes come from ./src/schema (GENERATED from the OpenAPI contract — run `npm run gen:client`
// after changing the spec), so the SDK can't silently drift from the API. `fetch` is injectable
// so callers/tests can drive it in-process without a network. Auth = a Bearer token: a Clerk
// session (human) or a rat_ agent token (ADR-007) — the same surface, per the design.
import type { components } from './src/schema';

type Schemas = components['schemas'];

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export class ControlPlaneError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

const enc = encodeURIComponent;

export class RatioControlPlane {
  private readonly base: string;
  private readonly token?: string;
  private readonly f: typeof fetch;

  constructor(opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const msg = (data as { error?: string })?.error || `HTTP ${res.status}`;
      throw new ControlPlaneError(res.status, msg, data);
    }
    return data as T;
  }

  me() {
    return this.req<Schemas['Identity']>('GET', '/me');
  }
  listStores() {
    return this.req<{ stores: Schemas['StoreSummary'][] }>('GET', '/stores');
  }
  createStore(input: Schemas['StoreCreate']) {
    return this.req<Schemas['StoreCreated']>('POST', '/stores', input);
  }
  getStore(id: string) {
    return this.req<Schemas['Store']>('GET', `/stores/${enc(id)}`);
  }
  deleteStore(id: string) {
    return this.req<Schemas['DeleteProof']>('DELETE', `/stores/${enc(id)}`);
  }
  getPage(id: string, path: string) {
    return this.req<Schemas['Page']>('GET', `/stores/${enc(id)}/page?path=${enc(path)}`);
  }
  putPage(id: string, input: Schemas['PageInput']) {
    return this.req<Schemas['Page']>('PUT', `/stores/${enc(id)}/page`, input);
  }
  listDomains(id: string) {
    return this.req<{ domains: Schemas['DomainStatus'][] }>('GET', `/stores/${enc(id)}/domains`);
  }
  connectDomain(id: string, host: string) {
    return this.req<Schemas['DomainConnection']>('POST', `/stores/${enc(id)}/domains`, { host });
  }
  mintAgentToken(id: string) {
    return this.req<Schemas['AgentToken']>('POST', `/stores/${enc(id)}/agent-tokens`);
  }
}
