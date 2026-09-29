// App-level commands shared by the shortcuts, the palette and the menus. Each one reads the
// stores itself so callers just say what they want done.
import type { SlashCommand } from './api/types';
import { fillComposer, focusComposer } from './composer/bridge';
import { slashText, wantsInput } from './composer/slash';
import type { ShortcutId } from './keymap';
import { adjacentId, nextAttentionId, railOrder } from './palette/order';
import type { PaletteActions } from './palette/palette';
import { openOverlay, openSettings } from './overlays';
import { active, nav, sessionsStore, settings, ui } from './state';
import { confirm, toast } from './ui';


class Busy {
  compacting = $state(false);
}
export const busy = new Busy();

export async function compactSession(): Promise<void> {
  if (busy.compacting || active.running || !active.gwId) return;
  busy.compacting = true;
  toast('Compacting context');
  try {
    await active.compact();
    toast('Context compacted');
  } catch (e) {
    ui.error(e instanceof Error ? e.message : 'Could not compact the session');
  } finally {
    busy.compacting = false;
  }
}

export async function stopActiveSession(): Promise<void> {
  const id = active.gwId;
  if (!id) return;
  const ok = await confirm({
    title: 'Stop this session',
    body: 'The transcript stays in History. You can resume it later.',
    confirmLabel: 'Stop session',
    danger: true,
  });
  if (ok) await nav.stop(id);
}

let lastDark: 'terminal' | 'graphite' | 'contrast' = 'terminal';

/** Flip between the light theme and the last dark one. Turns off follow-system so the choice sticks. */
export function toggleTheme(): void {
  const now = settings.effectiveTheme;
  if (now === 'paper') {
    settings.update({ theme: lastDark, followSystem: false });
  } else {
    lastDark = now;
    settings.update({ theme: 'paper', followSystem: false });
  }
}

function order() {
  return railOrder(sessionsStore.groups);
}

export function goNextAttention(): boolean {
  const id = nextAttentionId(order(), nav.gwId);
  if (!id) {
    toast('Nothing needs you right now');
    return true;
  }
  nav.open(id);
  return true;
}

function goAdjacent(dir: 1 | -1): boolean {
  const id = adjacentId(order(), nav.gwId, dir);
  if (!id) return false;
  nav.open(id);
  return true;
}

export function askRename(): void {
  ui.renameTick++;
}

export function useSlash(cmd: SlashCommand): void {
  if (!wantsInput(cmd)) void active.send(`/${cmd.name}`, active.running ? 'follow_up' : 'prompt');
  else fillComposer(slashText(cmd));
}

/** Runs a global shortcut. Returns false when there was nothing to do, so the key keeps its default. */
export function runShortcut(id: ShortcutId): boolean {
  switch (id) {
    case 'palette':
      if (ui.isOpen('palette')) ui.close('palette');
      else openOverlay('palette');
      return true;
    case 'settings':
      if (ui.isOpen('settings')) ui.tryClose('settings');
      else openSettings();
      return true;
    case 'new-session':
      ui.open('new-session');
      return true;
    case 'next-attention':
      return goNextAttention();
    case 'toggle-rail':
      if (ui.railCollapsed && !ui.isOpen('drawer')) ui.railCollapsed = false;
      else ui.railCollapsed = !ui.railCollapsed;
      return true;
    case 'close':
      return ui.escape();
    case 'focus-composer':
      return focusComposer();
    case 'prev-session':
      return goAdjacent(-1);
    case 'next-session':
      return goAdjacent(1);
    default:
      return false;
  }
}

export function paletteActions(): PaletteActions {
  return {
    newSession: () => ui.open('new-session'),
    nextAttention: () => void goNextAttention(),
    openSession: (gwId) => nav.open(gwId),
    resume: (saved) => void nav.resume(saved),
    openSettings: (page) => openSettings({ page }),
    toggleTheme,
    compact: () => void compactSession(),
    stop: () => void stopActiveSession(),
    rename: askRename,
    sessionInfo: () => openOverlay('session-info'),
    slash: useSlash,
  };
}
