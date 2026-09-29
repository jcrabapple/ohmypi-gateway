// Seam for overlays built after the core loop (palette, settings, session info,
// inspector). Register a component under its id and `openOverlay` shows it;
// until one is registered the click says so instead of doing nothing.
import type { Component } from 'svelte';
import type { SettingsTarget } from './palette/settings-index';
import { ui, type OverlayId } from './state/ui.svelte';

export interface OverlayProps {
  onclose: () => void;
}

export const overlayComponents: Partial<Record<OverlayId, Component<OverlayProps>>> = {};

export function registerOverlay(id: OverlayId, component: Component<OverlayProps>): void {
  overlayComponents[id] = component;
}

export function openOverlay(id: OverlayId): void {
  if (!overlayComponents[id]) {
    ui.toast('Not available yet');
    return;
  }
  ui.open(id);
}

/** Open settings on a page, and optionally at one setting. Re-aims it if it is already open. */
export function openSettings(target: SettingsTarget | null = null): void {
  ui.settingsAt = target;
  if (!ui.isOpen('settings')) openOverlay('settings');
}
