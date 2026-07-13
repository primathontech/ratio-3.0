import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
  moon: ({ size }: IconProps) => svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, size),
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
};

/* Spinner ---------------------------------------------------------------- */
export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

/* Badge ------------------------------------------------------------------ */
export function Badge({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return <span className={accent ? 'badge badge-accent' : 'badge'}>{children}</span>;
}

/* Field ------------------------------------------------------------------ */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
      <div className="toaster">
        {toasts.map((t) => (
          <div key={t.id} className={t.kind === 'error' ? 'toast error' : 'toast'}>
            <span className="bar" />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
