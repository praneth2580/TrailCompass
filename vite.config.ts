import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

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
  test: {
    environment: 'node',
    // *.scratch.test.ts files query live OSM servers and can run for many
    // minutes. They only run with LIVE_OSM=1, e.g. `LIVE_OSM=1 npm test`.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.LIVE_OSM ? [] : ['**/*.scratch.test.ts']),
    ],
  },
});
