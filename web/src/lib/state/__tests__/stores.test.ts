import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../api/types';
import { sessions as sessionsApi } from '../../api/endpoints';
import { active } from '../active.svelte';
import { sessionsStore } from '../sessions.svelte';
import { sanitizeSettings, settings } from '../settings.svelte';
import { ui } from '../ui.svelte';

function liveInfo(gwId: string): SessionInfo {
  return {
    gwId, cwd: '/work', approvalMode: 'yolo', resumedFrom: null, ompSessionId: null, ompSessionFile: null,
    ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false,
    exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0, contextUsage: null,
    lastEventSeq: 0, pendingUi: [],
  };
}

describe('settings', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to defaults for junk', () => {
    expect(sanitizeSettings(null).theme).toBe('terminal');
    const s = sanitizeSettings({ theme: 'neon', accent: 'red', density: 'tiny', width: 3, followSystem: 'yes', planPanelOpen: 'yes' });
    expect(s).toEqual({
      theme: 'terminal', accent: null, density: 'comfortable', width: 'reading', proseFont: 'sans', followSystem: false,
      planPanelOpen: null,
    });
  });

  it('keeps valid values', () => {
    const s = sanitizeSettings({ theme: 'paper', accent: '#22C55E', density: 'compact', width: 'wide', proseFont: 'mono', followSystem: true, planPanelOpen: true });
    expect(s.theme).toBe('paper');
    expect(s.accent).toBe('#22C55E');
    expect(s.followSystem).toBe(true);
    expect(s.planPanelOpen).toBe(true);
  });

  it('applies data attributes and the accent override to the root', () => {
    const root = document.createElement('html');
    settings.update({ theme: 'graphite', density: 'compact', accent: '#3b82f6', followSystem: false });
    settings.apply(root);
    expect(root.dataset.theme).toBe('graphite');
    expect(root.dataset.density).toBe('compact');
    expect(root.style.getPropertyValue('--accent')).toBe('#3b82f6');
    settings.update({ accent: null });
    settings.apply(root);
    expect(root.style.getPropertyValue('--accent')).toBe('');
    settings.reset();
  });

  it('follow system picks paper on a light OS and the dark choice otherwise', () => {
    settings.update({ theme: 'contrast', followSystem: true });
    settings.systemLight = true;
    expect(settings.effectiveTheme).toBe('paper');
    settings.systemLight = false;
    expect(settings.effectiveTheme).toBe('contrast');
    settings.update({ theme: 'paper' });
    expect(settings.effectiveTheme).toBe('terminal');
    settings.reset();
  });

  it('persists across a reload of the store data', () => {
    settings.update({ theme: 'graphite' });
    const stored = Object.entries(localStorage).find(([k]) => k.endsWith(':device:settings'));
    expect(JSON.parse(stored![1]).theme).toBe('graphite');
    settings.reset();
  });
});

describe('ui', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    while (ui.overlays.length) ui.close();
    ui.toasts.forEach((t) => ui.dismissToast(t.id));
  });

  it('closes overlays top-down and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    ui.open('palette', opener);
    ui.open('settings', null);
    expect(ui.top).toBe('settings');
    expect(ui.escape()).toBe(true);
    expect(ui.top).toBe('palette');
    expect(ui.escape()).toBe(true);
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
    expect(ui.escape()).toBe(false);
    opener.remove();
  });

  it('does not open the same overlay twice', () => {
    ui.open('drawer', null);
    ui.open('drawer', null);
    expect(ui.overlays).toHaveLength(1);
  });

  it('toasts expire', () => {
    ui.toast('hello');
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    expect(ui.toasts).toHaveLength(0);
  });

  it('confirm resolves from the buttons and from Escape', async () => {
    const yes = ui.confirm({ title: 't', confirmLabel: 'Stop' });
    ui.answerConfirm(true);
    expect(await yes).toBe(true);
    const no = ui.confirm({ title: 't', confirmLabel: 'Stop' });
    expect(ui.escape()).toBe(true);
    expect(await no).toBe(false);
    expect(ui.confirmRequest).toBeNull();
  });
});

describe('sessions store', () => {
  afterEach(() => {
    active.close();
    sessionsStore.live = [];
    sessionsStore.saved = [];
    sessionsStore.todoActive = new Set();
  });

  it('recomputes the rail groups when setTodoActive changes the Set', () => {
    sessionsStore.live = [liveInfo('gw-a'), liveInfo('gw-b')];
    expect(sessionsStore.groups.running).toHaveLength(0);

    const before = sessionsStore.todoActive;
    sessionsStore.setTodoActive('gw-a', true);
    expect(sessionsStore.todoActive).not.toBe(before);
    expect(sessionsStore.groups.running.map((s) => s.gwId)).toEqual(['gw-a']);
    expect(sessionsStore.groups.idle.map((s) => s.gwId)).toEqual(['gw-b']);

    sessionsStore.setTodoActive('gw-a', false);
    expect(sessionsStore.groups.running).toHaveLength(0);
    expect(sessionsStore.groups.idle.map((s) => s.gwId)).toEqual(['gw-a', 'gw-b']);
  });

  it('drops stale todo entries for background sessions on the global poll and keeps the open session', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(sessionsApi, 'list').mockResolvedValue({ live: [liveInfo('gw-a'), liveInfo('gw-b')], saved: [] });
      sessionsStore.live = [liveInfo('gw-a'), liveInfo('gw-b')];
      sessionsStore.setTodoActive('gw-a', true);
      sessionsStore.setTodoActive('gw-b', true);
      active.gwId = 'gw-a';

      vi.advanceTimersByTime(16_000);
      await sessionsStore.refresh();
      expect(sessionsStore.todoActive.has('gw-a')).toBe(true);
      expect(sessionsStore.todoActive.has('gw-b')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps recently refreshed todo entries across a poll', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(sessionsApi, 'list').mockResolvedValue({ live: [liveInfo('gw-b')], saved: [] });
      sessionsStore.live = [liveInfo('gw-b')];
      sessionsStore.setTodoActive('gw-b', true);

      await sessionsStore.refresh();
      expect(sessionsStore.todoActive.has('gw-b')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
