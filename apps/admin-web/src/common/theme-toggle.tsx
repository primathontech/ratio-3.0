import { useTheme } from './theme';
import { Icon } from './ui';

// Shared light/dark toggle button. Owns the useTheme wiring so callers just drop it in; `className`
// lets each surface style it (icon-btn in the app bar, a small ghost button in the editor).
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const { resolved, cycle } = useTheme();
  return (
    <button
      className={className}
      onClick={cycle}
      aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={resolved === 'dark' ? 'Light' : 'Dark'}
    >
      {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
}
