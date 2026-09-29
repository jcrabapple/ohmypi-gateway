// Light tap feedback on touch devices. No-op where vibrate is missing (iOS,
// desktop) or the primary pointer is not coarse.

export function tap(ms = 10): void {
  try {
    if (!globalThis.matchMedia?.('(pointer: coarse)').matches) return;
    globalThis.navigator?.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}
