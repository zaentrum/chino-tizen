import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Tizen web apps run the built bundle from a packaged origin (file://-like),
// so assets must be referenced relatively (base: ''). The es2018 target keeps
// us compatible with the broad Samsung TV baseline (Tizen 4.0 / 2018 WebKit).
export default defineConfig({
  base: '',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    target: 'es2018',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
