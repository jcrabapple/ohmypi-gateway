// Overlays, toasts and the confirm dialog. Overlays are a stack so Escape closes
// the top one, and each remembers the element that opened it so focus can return.

import type { SettingsTarget } from '../palette/settings-index';

export type OverlayId = 'drawer' | 'palette' | 'new-session' | 'settings' | 'inspector' | 'session-info';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
}

interface OverlayEntry {
  id: OverlayId;
  opener: HTMLElement | null;
}

const TOAST_MS = 5000;

class UiStore {
  overlays = $state<OverlayEntry[]>([]);
  toasts = $state<Toast[]>([]);
  confirmRequest = $state<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  railCollapsed = $state(false);
  /** The item the inspector overlay should show. Set by `inspect`. */
  inspecting = $state.raw<unknown>(null);
  /** Where the settings overlay should land when it opens or is re-aimed. */
  settingsAt = $state.raw<SettingsTarget | null>(null);
  /** Bumped to ask the session header to start renaming. */
  renameTick = $state(0);

  private guards = new Map<OverlayId, () => boolean>();
  private nextToast = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  get top(): OverlayId | null {
    return this.overlays.at(-1)?.id ?? null;
  }

  isOpen(id: OverlayId): boolean {
    return this.overlays.some((o) => o.id === id);
  }

  open(id: OverlayId, opener: HTMLElement | null = (document.activeElement as HTMLElement | null)): void {
    if (this.isOpen(id)) return;
    this.overlays = [...this.overlays, { id, opener }];
  }

  close(id?: OverlayId): void {
    const entry = id ? this.overlays.find((o) => o.id === id) : this.overlays.at(-1);
    if (!entry) return;
    this.overlays = this.overlays.filter((o) => o !== entry);
    const opener = entry.opener;
    if (opener?.isConnected) queueMicrotask(() => opener.focus());
  }

  /** An overlay with unsaved work registers a guard. It returns true to let the close go ahead. */
  guard(id: OverlayId, fn: (() => boolean) | null): void {
    if (fn) this.guards.set(id, fn);
    else this.guards.delete(id);
  }

  /** Close through the overlay's guard, if it has one. Returns false when the guard held it open. */
  tryClose(id?: OverlayId): boolean {
    const entry = id ? this.overlays.find((o) => o.id === id) : this.overlays.at(-1);
    if (!entry) return true;
    if (this.guards.get(entry.id)?.() === false) return false;
    this.close(entry.id);
    return true;
  }

  /** Show an item's raw source in the inspector overlay. */
  inspect(raw: unknown): void {
    this.inspecting = raw;
    this.open('inspector');
  }

  /** Escape handler: closes the confirm dialog first, then the top overlay. Returns true if it handled the key. */
  escape(): boolean {
    if (this.confirmRequest) {
      this.answerConfirm(false);
      return true;
    }
    if (this.overlays.length) {
      this.tryClose();
      return true;
    }
    return false;
  }

  toast(text: string, opts: { kind?: Toast['kind']; action?: Toast['action']; ms?: number } = {}): number {
    const id = this.nextToast++;
    this.toasts = [...this.toasts, { id, text, kind: opts.kind ?? 'info', action: opts.action }];
    this.timers.set(id, setTimeout(() => this.dismissToast(id), opts.ms ?? TOAST_MS));
    return id;
  }

  error(text: string): number {
    return this.toast(text, { kind: 'error', ms: 8000 });
  }

  dismissToast(id: number): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.toasts = this.toasts.filter((x) => x.id !== id);
  }

  confirm(req: ConfirmRequest): Promise<boolean> {
    this.confirmRequest?.resolve(false);
    return new Promise((resolve) => {
      this.confirmRequest = { ...req, resolve };
    });
  }

  answerConfirm(ok: boolean): void {
    const req = this.confirmRequest;
    if (!req) return;
    this.confirmRequest = null;
    req.resolve(ok);
  }
}

export const ui = new UiStore();
