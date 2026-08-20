import type { BaseThemeOption } from '../../common/api';
import './base-picker.css';

// The "start from" base chooser — selectable cards (name + description). Presentational: the container
// loads the options (api.listBaseThemes) and owns the selection. Renders nothing when there's only one
// base to pick, so a single-base install shows no needless control.
export function BasePicker({
  options,
  value,
  onChange,
}: {
  options: BaseThemeOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="base-picker" role="radiogroup" aria-label="Start from">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            type="button"
            key={o.id}
            role="radio"
            aria-checked={on}
            className={on ? 'base-opt on' : 'base-opt'}
            onClick={() => onChange(o.id)}
          >
            <span className="base-opt-name">{o.name}</span>
            <span className="base-opt-desc">{o.description}</span>
          </button>
        );
      })}
    </div>
  );
}
