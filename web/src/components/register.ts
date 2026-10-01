// Overlays built after the core loop plug in here, so Shell and the rail only know their ids.
import { registerOverlay } from '../lib/overlays';
import CleanupSheet from './CleanupSheet.svelte';
import CommandPalette from './CommandPalette.svelte';
import InspectorSheet from './InspectorSheet.svelte';
import SessionInfoSheet from './SessionInfoSheet.svelte';
import SettingsOverlay from './SettingsOverlay.svelte';

export function registerOverlays(): void {
  registerOverlay('palette', CommandPalette);
  registerOverlay('settings', SettingsOverlay);
  registerOverlay('session-info', SessionInfoSheet);
  registerOverlay('inspector', InspectorSheet);
  registerOverlay('session-cleanup', CleanupSheet);
}
