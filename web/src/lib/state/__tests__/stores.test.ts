import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeSettings, settings } from '../settings.svelte';
import { ui } from '../ui.svelte';

describe('settings', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to defaults for junk', () => {
    expect(sanitizeSettings(null).theme).toBe('terminal');
    const s = sanitizeSettings({ theme: 'neon', accent: 'red', density: 'tiny', width: 3, followSystem: 'yes' });
    expect(s).toEqual({
      theme: 'terminal', accent: null, density: 'comfortable', width: 'reading', proseFont: 'sans', followSystem: false,
    });
  });

  it('keeps valid values', () => {
    const s = sanitizeSettings({ theme: 'paper', accent: '#22C55E', density: 'compact', width: 'wide', proseFont: 'mono', followSystem: true });
    expect(s.theme).toBe('paper');
    expect(s.accent).toBe('#22C55E');
    expect(s.followSystem).toBe(true);
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
