import { describe, test, expect } from 'vitest';
import { subdomainFromName, suggestHost } from './host';

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
