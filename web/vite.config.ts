import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// The dev proxy keeps the browser's Host header (no changeOrigin) so the
// gateway's same-origin check on cookie auth sees Origin == Host.
const GATEWAY = process.env.OMPGW_URL ?? 'http://127.0.0.1:9315';

export default defineConfig({
  plugins: [svelte()],
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  server: {
    port: 5183,
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      '/api': GATEWAY,
      '/auth': GATEWAY,
      '/healthz': GATEWAY,
      '/.well-known': GATEWAY,
      '/omp-ws': { target: GATEWAY, ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
