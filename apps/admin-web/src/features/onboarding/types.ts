import type { Api } from '../../common/api';

export interface VerifyResult {
  configured: boolean;
  verified: boolean;
  collectionCount?: number;
}

// Everything the wizard collects across its steps. The store is created (as a draft) at the end of the
// Details step, which fills storeId / storeUrl / themeId for the Design + Launch steps to work on.
export interface WizardData {
  merchantId: string;
  // The merchant ID actually persisted on the store's commerce (set once the store exists). Lets the
  // Details step push a change made after creation — and skip a redundant edge-purging save when it
  // hasn't changed.
  savedMerchantId: string;
  verify: VerifyResult | null;
  skipCommerce: boolean; // the "set up catalog later" escape
  name: string;
  host: string;
  color: string;
  storeId: string | null;
  storeUrl: string | null;
  themeId: string | null;
}

export interface StepProps {
  api: Api;
  data: WizardData;
  patch: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
}

export const STEP_LABELS = ['Connect', 'Store', 'Design', 'Launch'];
