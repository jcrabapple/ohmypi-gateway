// Reactive viewport facts the primitives switch on. One listener each, for the page's lifetime.

class Viewport {
  /** Below 900 px: drawer rail, bottom sheets instead of popovers. */
  narrow = $state(false);
  coarse = $state(false);

  constructor() {
    this.track('(max-width: 899.98px)', (v) => (this.narrow = v));
    this.track('(pointer: coarse)', (v) => (this.coarse = v));
  }

  private track(query: string, set: (v: boolean) => void): void {
    const mq = globalThis.matchMedia?.(query);
    if (!mq) return;
    set(mq.matches);
    mq.addEventListener('change', (e) => set(e.matches));
  }
}

export const viewport = new Viewport();
