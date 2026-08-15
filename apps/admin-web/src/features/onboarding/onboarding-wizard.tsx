import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStoreData } from '../../common/store-context';
import { Stepper } from './stepper';
import { ConnectStep } from './steps/connect-step';
import { DetailsStep } from './steps/details-step';
import { DesignStep } from './steps/design-step';
import { LaunchStep } from './steps/launch-step';
import { STEP_LABELS, type WizardData } from './types';
import './onboarding-wizard.css';

const EMPTY: WizardData = {
  merchantId: '',
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
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>(EMPTY);

  const patch = (p: Partial<WizardData>) => setData((d) => ({ ...d, ...p }));
  const next = () => setStep((s) => Math.min(STEP_LABELS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <div className="ob-wrap">
      <header className="ob-top">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          Cancel
        </button>
        <Stepper steps={STEP_LABELS} current={step} />
        <span className="ob-top-spacer" />
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
              reload();
              navigate(data.storeId ? `/stores/${data.storeId}` : '/');
            }}
          />
        )}
      </main>
    </div>
  );
}
