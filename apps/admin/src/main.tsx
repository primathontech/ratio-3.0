import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { App } from './App';
import { ThemeProvider, useTheme } from './theme';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set');

// Theme the Clerk widgets to match the app chrome + current light/dark.
function clerkAppearance(dark: boolean) {
  return {
    variables: {
      colorPrimary: '#4f46e5',
      borderRadius: '8px',
      ...(dark
        ? {
            colorBackground: '#15181f',
            colorText: '#e7e9ee',
            colorTextSecondary: '#98a0ad',
            colorInputBackground: '#1b1f28',
            colorInputText: '#e7e9ee',
            colorPrimary: '#818cf8',
          }
        : {}),
    },
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
