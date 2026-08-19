import { describe, test, expect } from 'vitest';
import { storefrontUrl } from './store-context';
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
