// App-level commands shared by the shortcuts, the palette and the menus. Each one reads the
// stores itself so callers just say what they want done.
import type { SlashCommand, SessionEntry } from './api/types';
import { sessions as sessionsApi } from './api/endpoints';
import { saveDraft } from './composer/drafts';
import { fillComposer, focusComposer } from './composer/bridge';
import { entryForItem, forkable, prefixMissing, userTexts, userTextsBefore } from './fork';
import { slashText, wantsInput } from './composer/slash';
import type { ShortcutId } from './keymap';
import { adjacentId, nextAttentionId, railOrder } from './palette/order';
import type { PaletteActions } from './palette/palette';
import { openOverlay, openSettings } from './overlays';
import { active, nav, sessionsStore, settings, ui } from './state';
import { confirm, toast } from './ui';
import type { UserItem } from './transcript/types';


class Busy {
  compacting = $state(false);
  forking = $state(false);
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

// ---- fork (branch at a user message)

/** Open the forked session with the same bookkeeping as create: patch the
 *  store (prepends, no resort), note the parent, drop the stopped parent from
 *  the rail, seed the prefilled draft. `note` replaces the plain forked toast,
 *  e.g. when the child's history could not be fully verified. */
async function openFork(fromGwId: string, gwId: string, prefill: string | null,
                        note: string | null = null): Promise<void> {
  const info = await sessionsApi.info(gwId);
  sessionsStore.patch(info);
  sessionsStore.markForked(gwId, fromGwId);
  // The parent process was stopped server-side; keeping the row would ghost
  // the rail until the next poll. remove() filters, so a repeat is harmless.
  sessionsStore.remove(fromGwId);
  if (prefill) saveDraft(gwId, prefill);
  nav.open(gwId);
  void sessionsStore.refresh();
  toast(note ?? 'Forked to new session');
}

async function forkAt(fromGwId: string, entryId: string, prefill: string | null,
                      expected: string[] | null): Promise<void> {
  const res = await sessionsApi.fork(fromGwId, entryId);
  // The caller's text wins (it matches what the user sees); the gateway's
  // selectedText covers header-menu forks, which have no item to prefill from.
  const seed = prefill ?? (typeof res.text === 'string' && res.text ? res.text : null);
  // omp forks at the LIVE history. A failed or diverging prefix check must not
  // strand the user on the now-stopped parent, so always open the child and
  // surface any doubt as a note there.
  let note: string | null = null;
  if (expected) {
    try {
      const msgs = await sessionsApi.messages(res.gwId);
      if (prefixMissing(expected, userTexts(msgs.messages))) {
        note = 'The forked session is missing part of this history';
      }
    } catch {
      note = 'Could not verify the forked session history';
    }
  }
  try {
    await openFork(fromGwId, res.gwId, seed, note);
  } catch {
    // Opening failed: name the child so it stays findable in the rail.
    ui.error(`The fork was created as ${res.gwId} but could not be opened`);
  }
}

/** The live user entry ids, oldest first. A fetch failure means no fork. */
async function liveUserEntries(gwId: string): Promise<SessionEntry[]> {
  const res = await sessionsApi.entries(gwId);
  return res.entries.filter((e) => e.role === 'user');
}

function forkStaleToast(): void {
  ui.toast('This session has changed since it loaded', {
    kind: 'error',
    action: { label: 'Fork latest', run: () => void forkLatest() },
  });
}

/** Fork at the chosen user message: history before it becomes a new session
 *  and the message lands in the composer for a re-send. */
export async function forkFromItem(item: UserItem): Promise<void> {
  const id = active.gwId;
  if (!id || busy.forking || active.running || !forkable(item)) return;
  busy.forking = true;
  try {
    const entries = await liveUserEntries(id);
    const entry = entryForItem(item, entries);
    if (!entry) {
      forkStaleToast();
      return;
    }
    await forkAt(id, entry.entryId, item.text, userTextsBefore(active.transcript.items, item));
  } catch (e) {
    const err = e as { status?: number; message?: string };
    // 422 is the gateway's stale-entry verdict; a 400 mentioning the entry or
    // the branch is omp losing the race against a compaction between the
    // validation and the branch: same situation, same remedy.
    if (err.status === 422 || (err.status === 400 && /entr|branch/i.test(err.message ?? ''))) {
      forkStaleToast();
    } else {
      ui.error(e instanceof Error ? e.message : 'Could not fork the session');
    }
  } finally {
    busy.forking = false;
  }
}

/** Fork at the newest user message (header overflow: fork the conversation as
 *  it stands). The transcript may be stale here, so the ancestor check is
 *  skipped; the fork point is the gateway's live history either way. */
export async function forkLatest(): Promise<void> {
  const id = active.gwId;
  if (!id || busy.forking || active.running) return;
  busy.forking = true;
  try {
    const entries = await liveUserEntries(id);
    const last = entries.at(-1);
    if (!last?.entryId) {
      ui.error('Nothing to fork yet');
      return;
    }
    await forkAt(id, last.entryId, null, null);
  } catch (e) {
    ui.error(e instanceof Error ? e.message : 'Could not fork the session');
  } finally {
    busy.forking = false;
  }
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
    sessionChanges: () => {
      if (nav.gwId) nav.openChanges(nav.gwId);
    },
    slash: useSlash,
  };
}
