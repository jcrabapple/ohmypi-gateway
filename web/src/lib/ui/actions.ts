// Small Svelte actions shared by the primitives and the transcript.

export interface LongPressOptions {
  /** Called once when the press lasts `ms` without moving. Receives the pointer position. */
  onlongpress: (pos: { x: number; y: number }) => void;
  ms?: number;
  /** Disable without removing the action (e.g. while a message is streaming). */
  disabled?: boolean;
}

const MOVE_TOLERANCE = 10;

/** Long-press for touch and pen. Mouse users have hover actions instead. */
export function longpress(node: HTMLElement, opts: LongPressOptions) {
  let options = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };

  const down = (e: PointerEvent) => {
    if (options.disabled || e.pointerType === 'mouse' || !e.isPrimary) return;
    if ((e.target as Element | null)?.closest('a, button, input, textarea, [data-no-longpress]')) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      if (start) options.onlongpress(start);
    }, options.ms ?? 500);
  };
  const move = (e: PointerEvent) => {
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) cancel();
  };
  // The browser's own context menu would open on top of ours after a long press.
  const menu = (e: Event) => {
    if (fired) {
      e.preventDefault();
      fired = false;
    }
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('contextmenu', menu);
  node.addEventListener('scroll', cancel, { passive: true });

  return {
    update(next: LongPressOptions) {
      options = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('contextmenu', menu);
      node.removeEventListener('scroll', cancel);
    },
  };
}
