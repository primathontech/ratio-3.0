import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Resolve the shared token package to its TS source so Vite transpiles it (no build step) and the
  // editor stays byte-for-byte in sync with the storefront renderer.
  resolve: {
    alias: {
      '@ratio/design-tokens': fileURLToPath(
        new URL('../../packages/design-tokens/src/index.ts', import.meta.url)
      ),
    },
  },
  test: { globals: true, environment: 'node' },
});
