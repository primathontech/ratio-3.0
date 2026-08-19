import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStoreData } from '../../common/store-context';
import { Stepper } from './stepper';
import { ConnectStep } from './steps/connect-step';
import { DetailsStep } from './steps/details-step';
import { DesignStep } from './steps/design-step';
import { LaunchStep } from './steps/launch-step';
import { STEP_LABELS, type WizardData } from './types';
import { loadWizardState, saveWizardState, clearWizardState } from './wizard-state';
import './onboarding-wizard.css';

const EMPTY: WizardData = {
  merchantId: '',
  savedMerchantId: '',
  verify: null,
  skipCommerce: false,
  name: '',
  host: '',
  color: '#2563eb',
  storeId: null,
  storeUrl: null,
  themeId: null,
};

// The guided store-onboarding wizard (OFCE-618), a chrome-less route. Connect commerce → store
// details (creates a draft store) → design → launch (publishes it live). One store is created across
// the flow; the container owns the collected data + which step is showing.
export function OnboardingWizard() {
  const { api, me, reload } = useStoreData();
  const navigate = useNavigate();
  // Restore an in-progress wizard (survives a refresh) so we don't drop to step 1 and re-create the
  // already-created draft store. Read once on mount.
  const restored = useMemo(() => loadWizardState(), []);
  const [step, setStep] = useState(restored?.step ?? 0);
  const [data, setData] = useState<WizardData>(restored?.data ?? EMPTY);

  useEffect(() => {
    saveWizardState({ step, data });
  }, [step, data]);

  const patch = (p: Partial<WizardData>) => setData((d) => ({ ...d, ...p }));
  const next = () => setStep((s) => Math.min(STEP_LABELS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const exit = () => {
    clearWizardState();
    navigate('/');
  };

  return (
    <div className="ob-wrap">
      <header className="ob-top">
        <span className="ob-top-spacer" />
        <Stepper steps={STEP_LABELS} current={step} />
        <button className="btn btn-ghost btn-sm" onClick={exit}>
          X
        </button>
      </header>
      <main className="ob-main">
        {step === 0 && (
          <ConnectStep api={api} data={data} patch={patch} onNext={next} onBack={back} />
        )}
        {step === 1 && (
          <DetailsStep api={api} data={data} patch={patch} onNext={next} onBack={back} />
        )}
        {step === 2 && (
          <DesignStep api={api} data={data} patch={patch} onNext={next} onBack={back} />
        )}
        {step === 3 && (
          <LaunchStep
            api={api}
            data={data}
            isLocal={!!me?.isLocal}
            onBack={back}
            onDone={() => {
              clearWizardState();
              reload();
              navigate(data.storeId ? `/stores/${data.storeId}` : '/');
            }}
          />
        )}
      </main>
    </div>
  );
}
