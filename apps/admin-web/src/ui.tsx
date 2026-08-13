import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';

/* Error boundary --------------------------------------------------------- */
// A render-time throw (e.g. a malformed pageConfig reaching the editor) would otherwise unmount
// the whole app to a blank screen (M-4). Contain it to a scoped, recoverable fallback.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message?: string }
> {
  state: { hasError: boolean; message?: string } = { hasError: false };
  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error boundary caught:', error, info.componentStack);
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="empty" role="alert">
        <div className="emoji">⚠️</div>
        <strong style={{ color: 'var(--text)' }}>Something went wrong</strong>
        <p className="muted">This view hit an unexpected error.</p>
        {this.state.message && (
          <p
            className="muted"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              maxWidth: 560,
              wordBreak: 'break-word',
            }}
          >
            {this.state.message}
          </p>
        )}
        <button className="btn btn-ghost" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/* Icons (inline SVG, currentColor) --------------------------------------- */
type IconProps = { size?: number };
const svg = (path: ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);
export const Icon = {
  sun: ({ size }: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>,
      size
    ),
  moon: ({ size }: IconProps) =>
    svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, size),
  plus: ({ size }: IconProps) => svg(<path d="M12 5v14M5 12h14" />, size),
  external: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M14 4h6v6M20 4l-9 9" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </>,
      size
    ),
  back: ({ size }: IconProps) => svg(<path d="M15 18l-6-6 6-6" />, size),
  check: ({ size }: IconProps) => svg(<path d="M20 6L9 17l-5-5" />, size),
  up: ({ size }: IconProps) => svg(<path d="M18 15l-6-6-6 6" />, size),
  down: ({ size }: IconProps) => svg(<path d="M6 9l6 6 6-6" />, size),
  selector: ({ size }: IconProps) => svg(<path d="M8 9l4-4 4 4M8 15l4 4 4-4" />, size),
  more: ({ size }: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
      </>,
      size
    ),
  sparkles: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M12 3c.4 4 2.6 6.2 6.5 6.5-3.9.3-6.1 2.5-6.5 6.5-.4-4-2.6-6.2-6.5-6.5C9.4 9.2 11.6 7 12 3z" />
        <path d="M18.5 14.5c.2 1.9 1.1 2.8 3 3-1.9.2-2.8 1.1-3 3-.2-1.9-1.1-2.8-3-3 1.9-.2 2.8-1.1 3-3z" />
      </>,
      size
    ),
  trash: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
      </>,
      size
    ),
};

/* Spinner ---------------------------------------------------------------- */
export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

/* Badge ------------------------------------------------------------------ */
export function Badge({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return <span className={accent ? 'badge badge-accent' : 'badge'}>{children}</span>;
}

/* Field ------------------------------------------------------------------ */
export function Field({
  label,
  info,
  children,
}: {
  label: string;
  info?: string; // shown as an ⓘ tooltip next to the label
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {info && (
          <span
            className="field-info"
            title={info}
            aria-label={info}
            role="img"
            tabIndex={0}
            style={{ marginLeft: 6, cursor: 'help', opacity: 0.55 }}
          >
            ⓘ
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

/* EmptyState ------------------------------------------------------------- */
export function EmptyState({
  emoji,
  title,
  children,
}: {
  emoji: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="emoji">{emoji}</div>
      <strong style={{ color: 'var(--text)' }}>{title}</strong>
      {children}
    </div>
  );
}

/* Dialog ----------------------------------------------------------------- */
export function Dialog({
  title,
  onClose,
  children,
  size = 'default',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'default' | 'wide';
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest onClose in a ref so the focus-trap effect can run ONCE on open. Depending
  // on onClose (a fresh inline arrow from every caller) re-ran this effect on each parent
  // render — re-yanking focus to the first control and corrupting focus restoration (L3).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => el.offsetParent !== null);
    // Move focus into the dialog on open (first control, or the dialog itself).
    (focusables()[0] ?? dialog)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onCloseRef.current();
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return e.preventDefault(); // nothing to tab to — stay put
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.(); // restore focus to the trigger on close
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        ref={ref}
        className={size === 'wide' ? 'dialog card dialog--wide' : 'dialog card'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/* Toasts ----------------------------------------------------------------- */
type Toast = { id: number; msg: string; kind: 'ok' | 'error' };
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toaster" role="status" aria-live="polite" aria-atomic="true">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={t.kind === 'error' ? 'toast error' : 'toast'}
            role={t.kind === 'error' ? 'alert' : undefined}
          >
            <span className="bar" />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
