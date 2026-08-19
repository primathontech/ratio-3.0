import { describe, test, expect } from 'vitest';
import {
  loadWizardState,
  saveWizardState,
  clearWizardState,
  type WizardState,
} from './wizard-state';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const state: WizardState = {
  step: 2,
  data: {
    merchantId: 'm1',
    savedMerchantId: 'm1',
    verify: null,
    skipCommerce: false,
    name: 'Store A',
    host: 'store-a.ratiodev.in',
    color: '#2563eb',
    storeId: 't_abc',
    storeUrl: 'https://store-a.ratiodev.in',
    themeId: 't_abc-main',
  },
};

describe('wizard-state', () => {
  test('round-trips step + data so a refresh resumes with the created storeId', () => {
    const s = fakeStorage();
    saveWizardState(state, s);
    const back = loadWizardState(s);
    expect(back?.step).toBe(2);
    expect(back?.data.storeId).toBe('t_abc');
    expect(back).toEqual(state);
  });

  test('returns null when nothing is stored', () => {
    expect(loadWizardState(fakeStorage())).toBeNull();
  });

  test('returns null on a malformed / old-shape payload instead of throwing', () => {
    const s = fakeStorage();
    s.setItem('ratio.onboarding.v1', '{not json');
    expect(loadWizardState(s)).toBeNull();
    s.setItem('ratio.onboarding.v1', JSON.stringify({ step: 'x' }));
    expect(loadWizardState(s)).toBeNull();
  });

  test('clear removes the persisted state', () => {
    const s = fakeStorage();
    saveWizardState(state, s);
    clearWizardState(s);
    expect(loadWizardState(s)).toBeNull();
  });

  test('degrades quietly when storage is unavailable (null)', () => {
    expect(() => saveWizardState(state, null)).not.toThrow();
    expect(loadWizardState(null)).toBeNull();
    expect(() => clearWizardState(null)).not.toThrow();
  });
});
