import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base so assets resolve correctly inside the Capacitor Android WebView.
  base: './',
  server: {
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
