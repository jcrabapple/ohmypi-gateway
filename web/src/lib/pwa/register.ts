// Production-only service worker registration. In dev the worker would cache modules Vite is
// still rewriting, so it is never registered there.

export function shouldRegister(opts: { prod: boolean; hasServiceWorker: boolean; secure: boolean }): boolean {
  return opts.prod && opts.hasServiceWorker && opts.secure;
}

export function registerServiceWorker(): void {
  const ok = shouldRegister({
    prod: import.meta.env.PROD,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    secure: typeof window !== 'undefined' && window.isSecureContext,
  });
  if (!ok) return;
  // After load, so the worker's install never competes with first paint.
  const go = () => void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
