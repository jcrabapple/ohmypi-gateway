// Desktop notifications for "needs you" and "done" while the tab is hidden.
// Permission is only ever requested from a user gesture (call
// `requestPermission` from a click handler); `notify` never prompts.

export function canNotify(): boolean {
  return typeof Notification !== 'undefined';
}

export function permission(): NotificationPermission | 'unsupported' {
  return canNotify() ? Notification.permission : 'unsupported';
}

/** Call from a click or key handler only. */
export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface NotifyOptions {
  title: string;
  body?: string;
  /** Same tag replaces the earlier notification instead of stacking. */
  tag?: string;
  onClick?: () => void;
}

/** Shows a notification only when permission was granted and the tab is hidden. */
export function notify(opts: NotifyOptions): boolean {
  if (!canNotify() || Notification.permission !== 'granted') return false;
  if (typeof document !== 'undefined' && !document.hidden) return false;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => {
      globalThis.focus?.();
      opts.onClick?.();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
