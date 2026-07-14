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
});
