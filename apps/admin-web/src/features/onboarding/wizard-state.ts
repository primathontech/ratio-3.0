import type { WizardData } from './types';

// The wizard creates a real (draft) store mid-flow, so its progress must survive a page refresh:
// otherwise a reload drops back to step 1 with the created storeId lost, and re-submitting the same
// address hits "that domain is already connected to another store". We stash {step, data} in
// sessionStorage (per-tab, cleared on finish/exit) and restore it on mount.
const KEY = 'ratio.onboarding.v1';

export interface WizardState {
  step: number;
  data: WizardData;
}

// sessionStorage is absent under SSR/tests and access can throw in privacy mode — never let that
// break the wizard; degrade to no persistence.
function store(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function loadWizardState(s: Storage | null = store()): WizardState | null {
  const raw = s?.getItem(KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WizardState>;
    if (typeof v?.step !== 'number' || typeof v?.data !== 'object' || v.data === null) return null;
    return { step: v.step, data: v.data as WizardData };
  } catch {
    return null; // malformed/old shape — start fresh
  }
}

export function saveWizardState(state: WizardState, s: Storage | null = store()): void {
  try {
    s?.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota / disabled — persistence is best-effort */
  }
}

export function clearWizardState(s: Storage | null = store()): void {
  try {
    s?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
