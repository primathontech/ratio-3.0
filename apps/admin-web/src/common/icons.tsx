import type { ReactNode } from 'react';

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
  menu: ({ size }: IconProps) => svg(<path d="M4 6h16M4 12h16M4 18h16" />, size),
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
  // VS Code-style workbench icons.
  files: ({ size }: IconProps) =>
    svg(
      <>
        <rect x="8" y="8" width="11" height="12" rx="1.5" />
        <path d="M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-8A1.5 1.5 0 0 0 4 6.5v9A1.5 1.5 0 0 0 5.5 17H8" />
      </>,
      size
    ),
  search: ({ size }: IconProps) =>
    svg(
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </>,
      size
    ),
  newFile: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5M12 12v5M9.5 14.5h5" />
      </>,
      size
    ),
  newFolder: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M12 11v5M9.5 13.5h5" />
      </>,
      size
    ),
  collapseAll: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M5 7h14" />
        <path d="M7 11h10" />
        <path d="M9 15h6" />
        <path d="M11 19h2" />
      </>,
      size
    ),
  refresh: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
      </>,
      size
    ),
  file: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </>,
      size
    ),
};

/* File-type icon (theme editor) ------------------------------------------ */
// The colour class for a file's icon, by extension (green Liquid, blue CSS, …).
function fileColorClass(ext: string): string {
  if (ext === 'js' || ext === 'mjs' || ext === 'ts') return 'fi-js';
  if (ext === 'json') return 'fi-json';
  if (ext === 'css') return 'fi-css';
  if (ext === 'html' || ext === 'htm') return 'fi-html';
  if (ext === 'liquid') return 'fi-liquid';
  return 'fi-default';
}

// A distinct line-art glyph per file type (droplet = Liquid, braces = JSON, hash = CSS, …), drawn in
// currentColor so the colour class above tints it.
function fileGlyph(ext: string) {
  switch (ext) {
    case 'liquid':
      return <path d="M8 2.5S4 6.6 4 9.4a4 4 0 0 0 8 0C12 6.6 8 2.5 8 2.5z" />;
    case 'json':
      return (
        <>
          <path d="M7 3.4c-1.2 0-1.3.9-1.3 1.8 0 .8-.2 1.4-1 1.6.8.3 1 .8 1 1.6 0 .9.1 1.8 1.3 1.8" />
          <path d="M9 3.4c1.2 0 1.3.9 1.3 1.8 0 .8.2 1.4 1 1.6-.8.3-1 .8-1 1.6 0 .9-.1 1.8-1.3 1.8" />
        </>
      );
    case 'css':
      return <path d="M6.4 3 5.3 13M10.7 3 9.6 13M4 6.3h8M3.6 9.7h8" />;
    case 'html':
    case 'htm':
      return <path d="M6 5 3.2 8 6 11M10 5l2.8 3L10 11" />;
    case 'js':
    case 'mjs':
    case 'ts':
      return <path d="M6 5 3.4 8 6 11M10 5l2.6 3L10 11M9.2 4 6.8 12" />;
    default:
      return (
        <>
          <path d="M4.5 2.5h4l3 3v8h-7z" />
          <path d="M8.5 2.5v3h3" />
        </>
      );
  }
}

// Renders the icon for a file by its type — the one place that maps a path to its icon + colour, so
// the file tree (and anywhere else that lists files) stays consistent.
export function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (
    <span className={`fi ${fileColorClass(ext)}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {fileGlyph(ext)}
      </svg>
    </span>
  );
}
