import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerOverlays } from '../../components/register';
import { goNextAttention, runShortcut, toggleTheme } from '../actions.svelte';
import { session } from '../palette/__tests__/factories';
import { nav, sessionsStore, settings, ui } from '../state';

beforeEach(() => {
  registerOverlays();
  localStorage.clear();
  settings.update({ theme: 'terminal', followSystem: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionsStore.live = [];
  ui.toasts = [];
  ui.railCollapsed = false;
  while (ui.overlays.length) ui.close();
  settings.reset();
});

describe('toggleTheme', () => {
  it('goes to paper and back to the dark theme it left', () => {
    settings.update({ theme: 'graphite' });
    toggleTheme();
    expect(settings.effectiveTheme).toBe('paper');
    toggleTheme();
    expect(settings.effectiveTheme).toBe('graphite');
  });

  it('turns off follow-system so the choice sticks', () => {
    settings.update({ followSystem: true });
    toggleTheme();
    expect(settings.data.followSystem).toBe(false);
  });
});

describe('goNextAttention', () => {
  it('opens the next session with a request waiting', () => {
    const open = vi.spyOn(nav, 'open').mockImplementation(() => {});
    sessionsStore.live = [session('a'), session('b', { pendingUi: [{ id: 'r', method: 'confirm', title: 't' }] })];
    expect(goNextAttention()).toBe(true);
    expect(open).toHaveBeenCalledWith('b');
  });

  it('says so when nothing is waiting', () => {
    const open = vi.spyOn(nav, 'open').mockImplementation(() => {});
    sessionsStore.live = [session('a')];
    goNextAttention();
    expect(open).not.toHaveBeenCalled();
    expect(ui.toasts.at(-1)?.text).toBe('Nothing needs you right now');
  });
});

describe('runShortcut', () => {
  it('palette toggles', () => {
    runShortcut('palette');
    expect(ui.isOpen('palette')).toBe(true);
    runShortcut('palette');
    expect(ui.isOpen('palette')).toBe(false);
  });

  it('settings opens and the shortcut closes it again', () => {
    runShortcut('settings');
    expect(ui.isOpen('settings')).toBe(true);
    runShortcut('settings');
    expect(ui.isOpen('settings')).toBe(false);
  });

  it('new session opens its sheet', () => {
    runShortcut('new-session');
    expect(ui.isOpen('new-session')).toBe(true);
  });

  it('close reports whether an overlay took the key', () => {
    expect(runShortcut('close')).toBe(false);
    ui.open('palette', null);
    expect(runShortcut('close')).toBe(true);
    expect(ui.isOpen('palette')).toBe(false);
  });

  it('prev and next move through the rail order and wrap', () => {
    const open = vi.spyOn(nav, 'open').mockImplementation(() => {});
    sessionsStore.live = [session('a'), session('b')];
    vi.spyOn(nav, 'gwId', 'get').mockReturnValue('a');
    runShortcut('next-session');
    expect(open).toHaveBeenLastCalledWith('b');
    runShortcut('prev-session');
    expect(open).toHaveBeenLastCalledWith('b');
  });

  it('prev and next do nothing without sessions, leaving the key alone', () => {
    expect(runShortcut('next-session')).toBe(false);
  });

  it('toggle-rail flips the rail', () => {
    runShortcut('toggle-rail');
    expect(ui.railCollapsed).toBe(true);
    runShortcut('toggle-rail');
    expect(ui.railCollapsed).toBe(false);
  });

  it('local shortcuts are not handled here', () => {
    expect(runShortcut('send')).toBe(false);
  });
});
