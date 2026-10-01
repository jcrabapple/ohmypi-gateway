import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldRegister } from '../register';

type Route = (req: { method: string; url: string; mode?: string; range?: boolean }, origin: string) => 'navigate' | 'asset' | 'bypass';

// Evaluate the very file the build inlines into the service worker.
function loadRoute(): Route {
  const src = readFileSync(resolve(process.cwd(), 'sw/routing.js'), 'utf8');
  const scope: Record<string, unknown> = {};
  new Function('self', 'globalThis', `${src}`)(scope, scope);
  return (scope.ompSwRouting as { route: Route }).route;
}

const route = loadRoute();
const ORIGIN = 'https://omp.example.com';
const get = (path: string, mode?: string, origin = ORIGIN) => route({ method: 'GET', url: origin + path, mode }, ORIGIN);

describe('service worker routing', () => {
  it('navigations go network first', () => {
    expect(get('/', 'navigate')).toBe('navigate');
    expect(get('/index.html', 'navigate')).toBe('navigate');
    expect(get('/some/deep/link', 'navigate')).toBe('navigate');
  });

  it('hashed assets go cache first', () => {
    expect(get('/assets/index-Dk3sF9a1.js')).toBe('asset');
    expect(get('/assets/index-Dk3sF9a1.css')).toBe('asset');
  });

  it.each(['/api/sessions', '/api', '/auth/login', '/omp-ws/abc', '/healthz', '/.well-known/ompgw.json'])(
    'never touches %s, even as a navigation',
    (path) => {
      expect(get(path)).toBe('bypass');
      expect(get(path, 'navigate')).toBe('bypass');
    },
  );

  it('leaves the classic UI and its static files alone', () => {
    expect(get('/classic', 'navigate')).toBe('bypass');
    expect(get('/static/app.js')).toBe('bypass');
  });

  it('does not mistake a lookalike for a protected prefix', () => {
    expect(get('/apiary', 'navigate')).toBe('navigate');
    expect(get('/authors', 'navigate')).toBe('navigate');
  });

  it('bypasses everything that is not a plain same-origin GET', () => {
    expect(route({ method: 'POST', url: `${ORIGIN}/assets/x.js` }, ORIGIN)).toBe('bypass');
    expect(route({ method: 'GET', url: `${ORIGIN}/assets/x.js`, range: true }, ORIGIN)).toBe('bypass');
    expect(get('/assets/x.js', undefined, 'https://cdn.example.net')).toBe('bypass');
    expect(route({ method: 'GET', url: 'not a url' }, 'null')).toBe('bypass');
  });

  it('bypasses root files such as the manifest, worker and icons', () => {
    for (const p of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/favicon.svg']) expect(get(p)).toBe('bypass');
  });

  it('bypasses non-asset subresource requests', () => {
    expect(get('/somewhere')).toBe('bypass');
  });
});

describe('service worker script', () => {
  const sw = readFileSync(resolve(process.cwd(), 'sw/sw.js'), 'utf8');

  it('inlines the routing file, versions its cache and deletes old caches', () => {
    expect(sw).toContain('/*__ROUTING__*/');
    expect(sw).not.toContain('importScripts');
    expect(sw).toMatch(/CACHE = 'omp-shell-__BUILD__'/);
    expect(sw).toContain('caches.delete');
    expect(sw).toMatch(/filter\(\(n\) => n !== CACHE\)/);
  });

  it('never mentions the live endpoints outside the router', () => {
    const code = sw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const p of ['/auth', '/omp-ws', '/healthz']) expect(code).not.toContain(p);
    // /api is banned for ROUTING: the fetch handler must never touch live
    // endpoints. The pushsubscriptionchange handler legitimately CALLS
    // /api/push/* in the background to re-register rotated subscriptions -
    // that is a fetch from the worker, not the worker routing page traffic.
    const withoutPushRebind = code.split("addEventListener('pushsubscriptionchange'")[0];
    expect(withoutPushRebind).not.toContain('/api');
  });
});

describe('shouldRegister', () => {
  it('registers only in a production build, with support, on a secure origin', () => {
    expect(shouldRegister({ prod: true, hasServiceWorker: true, secure: true })).toBe(true);
    expect(shouldRegister({ prod: false, hasServiceWorker: true, secure: true })).toBe(false);
    expect(shouldRegister({ prod: true, hasServiceWorker: false, secure: true })).toBe(false);
    expect(shouldRegister({ prod: true, hasServiceWorker: true, secure: false })).toBe(false);
  });
});
