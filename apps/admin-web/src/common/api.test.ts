import { describe, test, expect } from 'vitest';
import { createApi, ApiError } from './api';

function fakeFetch(status: number, body: unknown, capture?: (req: Request) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture?.(new Request(typeof input === 'string' ? input : input.toString(), init));
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('admin api client', () => {
  test('attaches the Clerk session token as a bearer', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 'tok-123',
      fakeFetch(200, { stores: [] }, (r) => (seen = r))
    );
    await api.listStores();
    expect(seen?.headers.get('authorization')).toBe('Bearer tok-123');
  });

  test('unwraps the stores array', async () => {
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { stores: [{ id: 'a', name: 'A', role: 'owner' }] })
    );
    expect(await api.listStores()).toEqual([{ id: 'a', name: 'A', role: 'owner' }]);
  });

  test('throws ApiError with the status on a non-2xx (e.g. 403)', async () => {
    const api = createApi('http://api', async () => 't', fakeFetch(403, { error: 'forbidden' }));
    await expect(api.listStores()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
    await expect(api.listStores()).rejects.toBeInstanceOf(ApiError);
  });

  test('sends no auth header when unauthenticated (getToken null)', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => null,
      fakeFetch(200, { stores: [] }, (r) => (seen = r))
    );
    await api.listStores();
    expect(seen?.headers.get('authorization')).toBeNull();
  });

  test('mintAgentToken POSTs to the store agent-tokens endpoint and returns the key', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(201, { token: 'rat_abc', scope: ['t_x'], expiresIn: 3600 }, (r) => (seen = r))
    );
    const res = await api.mintAgentToken('t_x');
    expect(seen?.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/stores/t_x/agent-tokens');
    expect(res).toEqual({ token: 'rat_abc', scope: ['t_x'], expiresIn: 3600 });
  });

  test('deleteStore DELETEs the store endpoint', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, {}, (r) => (seen = r))
    );
    await api.deleteStore('t_x');
    expect(seen?.method).toBe('DELETE');
    expect(new URL(seen!.url).pathname).toBe('/stores/t_x');
  });

  test('getCommerce GETs and unwraps merchantId; saveCommerce PUTs it', async () => {
    let seen: Request | undefined;
    const get = createApi('http://api', async () => 't', fakeFetch(200, { merchantId: 'm1' }));
    expect(await get.getCommerce('t_x')).toBe('m1');
    const put = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, merchantId: 'm2' }, (r) => (seen = r))
    );
    await put.saveCommerce('t_x', 'm2');
    expect(seen?.method).toBe('PUT');
    expect(new URL(seen!.url).pathname).toBe('/stores/t_x/commerce');
  });

  test('listAudit unwraps the entries array', async () => {
    const entries = [
      { at: 't', actor: 'u', actorKind: 'user', action: 'pages:write', method: 'PUT', status: 200 },
    ];
    const api = createApi('http://api', async () => 't', fakeFetch(200, { entries }));
    expect(await api.listAudit('t_x')).toEqual(entries);
  });

  test('rejects with a clean ApiError when the request times out (M1)', async () => {
    const hang: typeof fetch = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as typeof fetch;
    const api = createApi('http://api', async () => 't', hang, { timeoutMs: 10 });
    await expect(api.listStores()).rejects.toBeInstanceOf(ApiError);
  });

  test('rejects (not infinite-loads) when a list response is missing its array (M2)', async () => {
    const api = createApi('http://api', async () => 't', fakeFetch(200, { wrong: [] }));
    await expect(api.listStores()).rejects.toBeInstanceOf(ApiError);
  });

  test('rejects with a clean ApiError on a non-JSON 2xx body (I6)', async () => {
    const html: typeof fetch = (async () =>
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    const api = createApi('http://api', async () => 't', html);
    await expect(api.listStores()).rejects.toBeInstanceOf(ApiError);
  });

  test('assistant() uses its own (longer) timeout, not the default (R12 M-1)', async () => {
    const hang: typeof fetch = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as typeof fetch;
    // Default timeout tiny, assistant timeout larger: a default call aborts fast; assistant
    // survives past the default window (proving it's on the separate, longer budget).
    const api = createApi('http://api', async () => 't', hang, {
      timeoutMs: 10,
      assistantTimeoutMs: 200,
    });
    const start = Date.now();
    await expect(api.assistant('hi')).rejects.toBeInstanceOf(ApiError);
    expect(Date.now() - start).toBeGreaterThan(50); // did not abort at the 10ms default
  });

  test('wraps a network failure in a clean ApiError (M1)', async () => {
    const boom: typeof fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const api = createApi('http://api', async () => 't', boom);
    await expect(api.listStores()).rejects.toBeInstanceOf(ApiError);
  });

  test('pbCatalog unwraps the sections array', async () => {
    const sections = [{ type: 'hero', kind: 'section', settings: [], blocks: [] }];
    const api = createApi('http://api', async () => 't', fakeFetch(200, { sections }));
    expect(await api.pbCatalog()).toEqual(sections);
  });

  test('getPageBuilder GETs the page-builder state with the path query', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(
        200,
        { path: '/', draft: null, live: null, revision: 0, hasDraft: false },
        (r) => (seen = r)
      )
    );
    await api.getPageBuilder('t_x', '/');
    expect(seen?.method).toBe('GET');
    const u = new URL(seen!.url);
    expect(u.pathname).toBe('/stores/t_x/page-builder');
    expect(u.searchParams.get('path')).toBe('/');
  });

  test('savePbDraft PUTs the doc wrapped in { doc }', async () => {
    let seen: Request | undefined;
    let bodyText = '';
    const capture = async (r: Request) => {
      seen = r;
      bodyText = await r.text();
    };
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, draft: {} }, (r) => void capture(r))
    );
    const doc = { path: '/', title: 'T', sections: [] };
    await api.savePbDraft('t_x', doc);
    expect(seen?.method).toBe('PUT');
    expect(new URL(seen!.url).pathname).toBe('/stores/t_x/page-builder');
    expect(JSON.parse(bodyText)).toEqual({ doc });
  });

  test('listPbPages unwraps the pages array', async () => {
    const pages = [{ path: '/', revision: 2, published: true, hasDraft: false }];
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { pages }, (r) => (seen = r))
    );
    expect(await api.listPbPages('t_x')).toEqual(pages);
    expect(new URL(seen!.url).pathname).toBe('/stores/t_x/page-builder/pages');
  });

  test('publishPb POSTs the path to the publish endpoint', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, revision: 3 }, (r) => (seen = r))
    );
    const res = await api.publishPb('t_x', '/');
    expect(seen?.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/stores/t_x/page-builder/publish');
    expect(res).toEqual({ ok: true, revision: 3 });
  });

  test('themeVersions unwraps the published pointer + versions', async () => {
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { published: 2, versions: [{ version: 2 }, { version: 1 }] })
    );
    expect(await api.themeVersions('s1')).toEqual({
      published: 2,
      versions: [{ version: 2 }, { version: 1 }],
    });
  });

  test('publishTheme POSTs to the publish endpoint with note + expectedBase', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, version: 3 }, (r) => (seen = r))
    );
    await api.publishTheme('s1', 'launch', 2);
    expect(seen?.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/publish');
    expect(await seen!.json()).toEqual({ note: 'launch', expectedBase: 2 });
  });

  test('rollbackTheme POSTs the target version', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, version: 1 }, (r) => (seen = r))
    );
    await api.rollbackTheme('s1', 1);
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/rollback');
    expect(await seen!.json()).toEqual({ version: 1 });
  });

  test('publishTheme surfaces a 409 (stale base) as ApiError', async () => {
    const api = createApi('http://api', async () => 't', fakeFetch(409, { error: 'conflict' }));
    await expect(api.publishTheme('s1', undefined, 0)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
    });
  });

  test('getBundleDraft GETs the draft endpoint and unwraps files + revision', async () => {
    let seen: Request | undefined;
    const files = { 'index.liquid': 'HELLO', 'theme.css': 'body{}' };
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { files, revision: 'r1' }, (r) => (seen = r))
    );
    expect(await api.getBundleDraft('s1')).toEqual({ files, revision: 'r1' });
    expect(seen?.method).toBe('GET');
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/bundle/draft');
  });

  test('getBundleDraft defaults to an empty map + revision when absent', async () => {
    const api = createApi('http://api', async () => 't', fakeFetch(200, {}));
    expect(await api.getBundleDraft('s1')).toEqual({ files: {}, revision: '' });
  });

  test('saveBundleDraft PUTs the files + revision', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, hash: 'h1' }, (r) => (seen = r))
    );
    const files = { 'index.liquid': 'X' };
    await api.saveBundleDraft('s1', files, 'r1');
    expect(seen?.method).toBe('PUT');
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/bundle/draft');
    expect(await seen!.json()).toEqual({ files, revision: 'r1' });
  });

  test('scaffoldBundleDraft POSTs to scaffold and unwraps files + revision', async () => {
    let seen: Request | undefined;
    const files = { 'layout/theme.liquid': '<html></html>' };
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { files, seeded: true, revision: 'r0' }, (r) => (seen = r))
    );
    expect(await api.scaffoldBundleDraft('s1')).toEqual({ files, revision: 'r0' });
    expect(seen?.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/bundle/scaffold');
  });

  test('previewBundle POSTs files + page and returns the rendered html', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { html: '<html>hi</html>' }, (r) => (seen = r))
    );
    const res = await api.previewBundle('s1', { 'x.liquid': 'y' }, 'index');
    expect(seen?.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/bundle/preview');
    expect(await seen!.json()).toEqual({ files: { 'x.liquid': 'y' }, page: 'index' });
    expect(res).toEqual({ html: '<html>hi</html>' });
  });

  test('publishBundle POSTs to the bundle publish endpoint', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, version: 1 }, (r) => (seen = r))
    );
    expect(await api.publishBundle('s1')).toEqual({ ok: true, version: 1 });
    expect(seen?.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/bundle/publish');
  });

  test('publishBundle surfaces a 400 (no draft) as ApiError', async () => {
    const api = createApi('http://api', async () => 't', fakeFetch(400, { error: 'no draft' }));
    await expect(api.publishBundle('s1')).rejects.toMatchObject({ name: 'ApiError', status: 400 });
  });

  test('rollbackBundle POSTs the target version', async () => {
    let seen: Request | undefined;
    const api = createApi(
      'http://api',
      async () => 't',
      fakeFetch(200, { ok: true, version: 2 }, (r) => (seen = r))
    );
    await api.rollbackBundle('s1', 2);
    expect(new URL(seen!.url).pathname).toBe('/stores/s1/theme/bundle/rollback');
    expect(await seen!.json()).toEqual({ version: 2 });
  });
});
