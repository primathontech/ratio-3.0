import type { ReactNode } from 'react';

// The shared page header: a title + optional description on the left, and an actions bar (children)
// on the right. One place owns the h1/description spacing and the action layout (.page-head styles),
// so every page reads the same.
export function PageHeader({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="head-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
