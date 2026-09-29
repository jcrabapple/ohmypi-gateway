// Edge-swipe intent for the mobile drawer. Pure so it can be tested without touch events.

export const EDGE_PX = 24;
export const SWIPE_PX = 56;
/** How much more horizontal than vertical a drag must be to count as a swipe. */
const AXIS_RATIO = 1.6;

export interface Point {
  x: number;
  y: number;
}

export type SwipeIntent = 'open' | 'close' | null;

export function startsAtEdge(p: Point): boolean {
  return p.x <= EDGE_PX;
}

export function swipeIntent(start: Point, now: Point, drawerOpen: boolean): SwipeIntent {
  const dx = now.x - start.x;
  const dy = now.y - start.y;
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) return null;
  if (!drawerOpen && dx > 0 && startsAtEdge(start)) return 'open';
  if (drawerOpen && dx < 0) return 'close';
  return null;
}

/** Wire touch listeners on the window. Returns a stop function. */
export function watchEdgeSwipe(opts: {
  isOpen: () => boolean;
  enabled: () => boolean;
  onOpen: () => void;
  onClose: () => void;
}): () => void {
  let start: Point | null = null;
  const begin = (e: TouchEvent) => {
    const t = e.touches[0];
    start = t && opts.enabled() && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
    if (start && !opts.isOpen() && !startsAtEdge(start)) start = null;
  };
  const move = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!start || !t) return;
    const intent = swipeIntent(start, { x: t.clientX, y: t.clientY }, opts.isOpen());
    if (!intent) return;
    start = null;
    if (intent === 'open') opts.onOpen();
    else opts.onClose();
  };
  const end = () => {
    start = null;
  };
  window.addEventListener('touchstart', begin, { passive: true });
  window.addEventListener('touchmove', move, { passive: true });
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', end, { passive: true });
  return () => {
    window.removeEventListener('touchstart', begin);
    window.removeEventListener('touchmove', move);
    window.removeEventListener('touchend', end);
    window.removeEventListener('touchcancel', end);
  };
}
