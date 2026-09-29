import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Build dist/sw.js from sw/sw.js: inline the routing function so there is a single worker file
// that no CDN can pin at a different version, and stamp the cache name with a hash of the built
// asset names so every deploy that changes an asset gets a fresh cache.
function buildServiceWorker() {
  return {
    name: 'build-sw',
    apply: 'build' as const,
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      let assets: string[];
      try {
        assets = readdirSync(join(dist, 'assets'));
      } catch {
        return;
      }
      const id = createHash('sha256').update(assets.sort().join('|')).digest('hex').slice(0, 10);
      const routing = readFileSync(join(process.cwd(), 'sw/routing.js'), 'utf8');
      const src = readFileSync(join(process.cwd(), 'sw/sw.js'), 'utf8');
      writeFileSync(join(dist, 'sw.js'), src.replace('/*__ROUTING__*/', () => routing).replaceAll('__BUILD__', id));
    },
  };
}

// The dev proxy keeps the browser's Host header so the gateway's same-origin check on
// cookie auth sees Origin == Host. The string shorthand turns changeOrigin on, so spell it out.
const GATEWAY = process.env.OMPGW_URL ?? 'http://127.0.0.1:9315';
const passthrough = { target: GATEWAY, changeOrigin: false };

export default defineConfig({
  plugins: [svelte(), buildServiceWorker()],
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
    // Component CSS must actually load so tests can assert on injected style rules
    // (e.g. the sticky plan-ribbon lead) and happy-dom can apply real styling.
    css: true,
  },
});
