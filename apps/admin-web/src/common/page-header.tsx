import type { ReactNode } from 'react';
import { Icon } from './ui';

// The shared page header: a title + optional description on the left, and an actions bar (children)
// on the right. Pass `onBack` to render a back button above the title (e.g. a sub-page returning to
// its index). One place owns the .page-head layout + spacing, so every page reads the same.
export function PageHeader({
  title,
  description,
  onBack,
  backLabel = 'Back',
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="head-text">
        <div className="page-head-titlerow">
          {onBack && (
            <button className="btn btn-ghost btn-sm page-head-back" onClick={onBack}>
              <Icon.back /> {backLabel}
            </button>
          )}
          <h1>{title}</h1>
        </div>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
