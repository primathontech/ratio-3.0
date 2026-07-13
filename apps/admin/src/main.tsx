import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { dark } from '@clerk/themes';
import { App } from './App';
import { ThemeProvider, useTheme } from './theme';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set');

// Theme the Clerk widgets to match the app chrome. Use Clerk's official dark base theme
// (covers social buttons, menus, borders — not just a few colours) + our accent.
function clerkAppearance(isDark: boolean) {
  return {
    baseTheme: isDark ? dark : undefined,
    variables: { colorPrimary: isDark ? '#818cf8' : '#4f46e5', borderRadius: '8px' },
  };
}

function Root() {
  const { resolved } = useTheme();
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={clerkAppearance(resolved === 'dark')}>
      <App />
    </ClerkProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </StrictMode>
);
