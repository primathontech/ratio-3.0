// CdnReadObjectStore is pure — a fake inner store + an injected fetch, no network/MinIO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdnReadObjectStore } from '../cdn-read';
import type { ObjectStore } from '../object-store';

const enc = (s: string) => new TextEncoder().encode(s);

function fakeInner(): ObjectStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(k) {
      calls.push('get:' + k);
      return enc('from-s3');
    },
    async put(k) {
      calls.push('put:' + k);
      return { etag: 'e' };
    },
    async head(k) {
      calls.push('head:' + k);
      return { etag: 'e' };
    },
    async delete(k) {
      calls.push('delete:' + k);
    },
  } as ObjectStore & { calls: string[] };
}

test('immutable published/ key is read from the CDN, not the inner store', async () => {
  let url = '';
  const inner = fakeInner();
  const cdn = new CdnReadObjectStore(inner, 'https://cdn.example', {
    fetchImpl: (async (u: string | URL) => {
      url = String(u);
      return new Response(enc('BUNDLE'), { status: 200 });
    }) as typeof fetch,
  });
  const bytes = await cdn.get('themes/t1/published/compiled/abc.gz');
  assert.equal(new TextDecoder().decode(bytes!), 'BUNDLE');
  assert.equal(url, 'https://cdn.example/themes/t1/published/compiled/abc.gz');
  assert.deepEqual(inner.calls, []); // inner never touched
});

test('CDN non-2xx falls back to the inner (authoritative) store', async () => {
  const inner = fakeInner();
  const cdn = new CdnReadObjectStore(inner, 'https://cdn.example', {
    fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
  });
  const bytes = await cdn.get('themes/t1/published/compiled/abc.gz');
  assert.equal(new TextDecoder().decode(bytes!), 'from-s3');
  assert.deepEqual(inner.calls, ['get:themes/t1/published/compiled/abc.gz']);
});

test('CDN network error falls back to the inner store', async () => {
  const inner = fakeInner();
  const cdn = new CdnReadObjectStore(inner, 'https://cdn.example', {
    fetchImpl: (async () => {
      throw new Error('boom');
    }) as typeof fetch,
  });
  await cdn.get('themes/t1/published/compiled/abc.gz');
  assert.deepEqual(inner.calls, ['get:themes/t1/published/compiled/abc.gz']);
});

test('mutable (draft) keys never touch the CDN', async () => {
  let cdnCalled = false;
  const inner = fakeInner();
  const cdn = new CdnReadObjectStore(inner, 'https://cdn.example', {
    fetchImpl: (async () => {
      cdnCalled = true;
      return new Response('', { status: 200 });
    }) as typeof fetch,
  });
  await cdn.get('themes/t1/draft/source.gz');
  assert.equal(cdnCalled, false);
  assert.deepEqual(inner.calls, ['get:themes/t1/draft/source.gz']);
});

test('writes/head/delete always go to the inner store, never the CDN', async () => {
  const inner = fakeInner();
  const cdn = new CdnReadObjectStore(inner, 'https://cdn.example', {
    fetchImpl: (async () => {
      throw new Error('CDN must not be called for writes');
    }) as typeof fetch,
  });
  await cdn.put('themes/t1/published/compiled/x.gz', enc('x'));
  await cdn.head('themes/t1/published/compiled/x.gz');
  await cdn.delete('themes/t1/published/compiled/x.gz');
  assert.deepEqual(inner.calls, [
    'put:themes/t1/published/compiled/x.gz',
    'head:themes/t1/published/compiled/x.gz',
    'delete:themes/t1/published/compiled/x.gz',
  ]);
});

test('keyPrefix is applied to the CDN URL and a trailing slash on the base is trimmed', async () => {
  let url = '';
  const cdn = new CdnReadObjectStore(fakeInner(), 'https://cdn.example/', {
    keyPrefix: 'ns/',
    fetchImpl: (async (u: string | URL) => {
      url = String(u);
      return new Response(enc('B'), { status: 200 });
    }) as typeof fetch,
  });
  await cdn.get('themes/t1/published/compiled/abc.gz');
  assert.equal(url, 'https://cdn.example/ns/themes/t1/published/compiled/abc.gz');
});
