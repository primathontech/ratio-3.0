import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

export type MenuAction = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

// A compact "⋯" row-actions menu. Positioned fixed so it escapes the table/card overflow clip;
// closes on outside click, Escape, or scroll.
export function RowMenu({ actions, label = 'Actions' }: { actions: MenuAction[]; label?: string }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    // Escape returns focus to the trigger (WCAG 2.4.3); outside-click just closes.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (open) popRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) return setPos(null);
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }

  return (
    <>
      <button
        ref={btnRef}
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={toggle}
      >
        <Icon.more size={16} />
      </button>
      {open && (
        <div
          ref={popRef}
          className="row-menu-pop"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className={a.danger ? 'danger' : ''}
              disabled={a.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setPos(null);
                btnRef.current?.focus();
                a.onClick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
