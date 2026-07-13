import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'ratio-admin-theme';

type Ctx = { theme: Theme; resolved: 'light' | 'dark'; setTheme: (t: Theme) => void; cycle: () => void };
const ThemeCtx = createContext<Ctx | null>(null);

// Shared light/dark/system state. 'system' clears data-theme so the CSS prefers-color-scheme
// media query drives it; explicit values stamp the root. One source so the app chrome AND
// the Clerk components (themed via appearance) stay in sync.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme) || 'system');
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const cycle = () => setTheme(resolved === 'dark' ? 'light' : 'dark');

  return <ThemeCtx.Provider value={{ theme, resolved, setTheme, cycle }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error('useTheme must be used within ThemeProvider');
  return c;
}
