import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Stamp the service worker's cache name with a hash of the built asset names, so every deploy
// that changes an asset gets a fresh cache and activate deletes the old one.
function stampServiceWorker() {
  return {
    name: 'stamp-sw',
    apply: 'build' as const,
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      const file = join(dist, 'sw.js');
      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        return;
      }
      const names = readdirSync(join(dist, 'assets')).sort().join('|');
      const id = createHash('sha256').update(names).digest('hex').slice(0, 10);
      writeFileSync(file, src.replaceAll('__BUILD__', id));
    },
  };
}

// The dev proxy keeps the browser's Host header so the gateway's same-origin check on
// cookie auth sees Origin == Host. The string shorthand turns changeOrigin on, so spell it out.
const GATEWAY = process.env.OMPGW_URL ?? 'http://127.0.0.1:9315';
const passthrough = { target: GATEWAY, changeOrigin: false };

export default defineConfig({
  plugins: [svelte(), stampServiceWorker()],
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
