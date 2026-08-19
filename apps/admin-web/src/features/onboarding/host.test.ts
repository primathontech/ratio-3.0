import { describe, test, expect } from 'vitest';
import { subdomainFromName, suggestHost, liveStoreUrl } from './host';

describe('liveStoreUrl', () => {
  test('local dev opens the <label>.localhost edge alias, not the prod host', () => {
    // Provisioning registers `${host.split('.')[0]}.localhost` as the local alias, so the wizard must
    // open that — the entered host (a .ratiodev.in subdomain) doesn't resolve to localhost.
    expect(liveStoreUrl('store-a.ratiodev.in', 'https://store-a.ratiodev.in/', true)).toBe(
      'http://store-a.localhost:8080'
    );
  });
  test('production uses the API-returned url', () => {
    expect(liveStoreUrl('store-a.ratiodev.in', 'https://store-a.ratiodev.in/', false)).toBe(
      'https://store-a.ratiodev.in/'
    );
  });
  test('production falls back to https://host when no url is given', () => {
    expect(liveStoreUrl('store-a.ratiodev.in', null, false)).toBe('https://store-a.ratiodev.in');
  });
});

describe('subdomainFromName', () => {
  test('slugifies to a-z0-9 with single hyphens, trimmed', () => {
    expect(subdomainFromName('Acme Store')).toBe('acme-store');
    expect(subdomainFromName('  Björk & Co!!  ')).toBe('bj-rk-co');
    expect(subdomainFromName('---Already-Slug---')).toBe('already-slug');
  });

  test('caps length and yields empty for non-alphanumeric input', () => {
    expect(subdomainFromName('!!!')).toBe('');
    expect(subdomainFromName('x'.repeat(60))).toHaveLength(40);
  });
});

describe('suggestHost', () => {
  test('appends the platform domain, or empty when no slug', () => {
    expect(suggestHost('Acme Store')).toBe('acme-store.ratiodev.in');
    expect(suggestHost('   ')).toBe('');
  });
});
