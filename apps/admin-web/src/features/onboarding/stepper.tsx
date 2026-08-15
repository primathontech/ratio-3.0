// The wizard progress rail. Presentational — the container owns which step is current.
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="ob-stepper" aria-label="Onboarding progress">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'on' : '';
        return (
          <li
            key={label}
            className={`ob-step ${state}`}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="ob-step-dot">{i < current ? '✓' : i + 1}</span>
            <span className="ob-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
