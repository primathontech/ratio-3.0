import { describe, test, expect } from 'vitest';
import { storefrontUrl, storefrontHost } from './store-context';
import type { Store } from './api';

const store = (over: Partial<Store>): Store => ({ id: 't_a', role: 'owner', ...over }) as Store;

describe('storefrontUrl', () => {
  test('local dev opens the .localhost edge alias, not the prod domain', () => {
    const s = store({
      host: 'store-a.ratiodev.in',
      hosts: ['store-a.ratiodev.in', 'store-a.localhost'],
    });
    expect(storefrontUrl(s, true)).toBe('http://store-a.localhost:8080');
  });

  test('production opens the real domain over https', () => {
    const s = store({
      host: 'store-a.ratiodev.in',
      hosts: ['store-a.ratiodev.in', 'store-a.localhost'],
    });
    expect(storefrontUrl(s, false)).toBe('https://store-a.ratiodev.in');
  });

  test('null when there is no matching host for the environment', () => {
    expect(storefrontUrl(store({ host: 'store-a.ratiodev.in' }), true)).toBeNull(); // no .localhost
    expect(storefrontUrl(store({ hosts: ['store-a.localhost'] }), false)).toBeNull(); // no real domain
  });
});

describe('storefrontHost', () => {
  const s = store({
    host: 'store-a.ratiodev.in',
    hosts: ['store-a.ratiodev.in', 'store-a.localhost'],
  });
  test('shows the reachable host without the scheme, matching where the link opens', () => {
    expect(storefrontHost(s, true)).toBe('store-a.localhost:8080'); // local alias, incl. port
    expect(storefrontHost(s, false)).toBe('store-a.ratiodev.in');
  });
  test('null when there is no reachable host for the environment', () => {
    expect(storefrontHost(store({ hosts: ['store-a.localhost'] }), false)).toBeNull();
  });
});
