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
    await expect(api.listPages('x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
    await expect(api.listPages('x')).rejects.toBeInstanceOf(ApiError);
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

  test('listAudit unwraps the entries array', async () => {
    const entries = [{ at: 't', actor: 'u', actorKind: 'user', action: 'pages:write', method: 'PUT', status: 200 }];
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
});
