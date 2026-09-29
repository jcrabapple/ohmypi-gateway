// Publishes the on-screen keyboard height as `--kb` (px) on :root so the
// composer can sit above it. visualViewport shrinks when the keyboard opens on
// mobile; layout viewport does not, so the difference is the keyboard.

const MIN_KEYBOARD_PX = 120;

export interface KeyboardOptions {
  root?: HTMLElement;
  win?: Window;
}

/** Height covered by the keyboard, or 0 when it is closed or the page is pinch-zoomed. */
export function keyboardInset(win: Pick<Window, 'innerHeight' | 'visualViewport'>): number {
  const vv = win.visualViewport;
  if (!vv || vv.scale > 1) return 0;
  const inset = win.innerHeight - vv.height - vv.offsetTop;
  return inset >= MIN_KEYBOARD_PX ? Math.round(inset) : 0;
}

/** Start tracking. Returns a stop function. */
export function watchKeyboard(opts: KeyboardOptions = {}): () => void {
  const win = opts.win ?? window;
  const root = opts.root ?? win.document.documentElement;
  const vv = win.visualViewport;
  root.style.setProperty('--kb', '0px');
  if (!vv) return () => {};

  let frame = 0;
  const apply = () => {
    frame = 0;
    root.style.setProperty('--kb', `${keyboardInset(win)}px`);
  };
  const schedule = () => {
    if (frame) return;
    frame = win.requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  schedule();

  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (frame) win.cancelAnimationFrame(frame);
    root.style.removeProperty('--kb');
  };
}
