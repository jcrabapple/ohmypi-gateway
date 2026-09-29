// The primitives, plus the two imperative entry points: ask with `confirm()`, tell with `toast()`.
import { ui, type ConfirmRequest } from '../state/ui.svelte';

export { default as Adaptive } from './Adaptive.svelte';
export { default as ConfirmDialog } from './ConfirmDialog.svelte';
export { default as Icon } from './Icon.svelte';
export { default as Kbd } from './Kbd.svelte';
export { default as Menu, type MenuItem } from './Menu.svelte';
export { default as Popover } from './Popover.svelte';
export { default as Segmented } from './Segmented.svelte';
export { default as Sheet } from './Sheet.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as Toasts } from './Toasts.svelte';
export type { IconName } from './icons';

/** Ask a yes/no question. Resolves true on confirm, false on cancel or Escape. */
export function confirm(req: ConfirmRequest): Promise<boolean> {
  return ui.confirm(req);
}

/** Show a short message. Errors stay longer. */
export function toast(text: string, opts?: Parameters<typeof ui.toast>[1]): number {
  return ui.toast(text, opts);
}
