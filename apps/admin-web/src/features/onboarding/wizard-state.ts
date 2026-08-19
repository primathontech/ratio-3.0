import { STEP_LABELS, type WizardData } from './types';

// The wizard creates a real (draft) store mid-flow, so its progress must survive a page refresh:
// otherwise a reload drops back to step 1 with the created storeId lost, and re-submitting the same
// address hits "that domain is already connected to another store". We stash {step, data} in
// sessionStorage (per-tab, cleared on finish/exit) and restore it on mount.
const KEY = 'ratio.onboarding.v1';
// Only resume a recently-touched wizard. Past this, a revisit to /stores/new starts fresh rather than
// silently dropping the merchant back into a stale, half-built draft they'd forgotten about.
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

export interface WizardState {
  step: number;
  data: WizardData;
}

interface StoredState extends WizardState {
  savedAt: number;
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
    const v = JSON.parse(raw) as Partial<StoredState>;
    if (typeof v?.step !== 'number' || typeof v?.data !== 'object' || v.data === null) return null;
    if (typeof v.savedAt === 'number' && Date.now() - v.savedAt > MAX_AGE_MS) return null; // stale
    // Clamp to a real step so an old payload (fewer/more steps) can't strand the wizard off-range.
    const step = Math.min(Math.max(0, v.step), STEP_LABELS.length - 1);
    return { step, data: v.data as WizardData };
  } catch {
    return null; // malformed/old shape — start fresh
  }
}

export function saveWizardState(state: WizardState, s: Storage | null = store()): void {
  try {
    const stored: StoredState = { ...state, savedAt: Date.now() };
    s?.setItem(KEY, JSON.stringify(stored));
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
