import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// The dev proxy keeps the browser's Host header so the gateway's same-origin check on
// cookie auth sees Origin == Host. The string shorthand turns changeOrigin on, so spell it out.
const GATEWAY = process.env.OMPGW_URL ?? 'http://127.0.0.1:9315';
const passthrough = { target: GATEWAY, changeOrigin: false };

export default defineConfig({
  plugins: [svelte()],
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  server: {
    port: 5183,
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      '/api': passthrough,
      '/auth': passthrough,
      '/healthz': passthrough,
      '/.well-known': passthrough,
      '/omp-ws': { ...passthrough, ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
