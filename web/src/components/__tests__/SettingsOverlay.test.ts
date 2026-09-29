import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, host } from '../../lib/api/endpoints';
import { configDraft } from '../../lib/state/config-draft.svelte';
import { ui } from '../../lib/state/ui.svelte';
import SettingsOverlay from '../SettingsOverlay.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

beforeEach(() => {
  vi.spyOn(host, 'system').mockReturnValue(new Promise(() => {}));
  vi.spyOn(auth, 'me').mockReturnValue(new Promise(() => {}));
  vi.spyOn(host, 'config').mockResolvedValue({ raw: 'a: 1\n', parsed: { a: 1 }, file: '/x/config.yml' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  ui.confirmRequest = null;
  ui.settingsAt = null;
  while (ui.overlays.length) ui.close();
  configDraft.discard();
});

function mountSettings() {
  ui.open('settings', null);
  const r = render(SettingsOverlay, { onclose: () => ui.tryClose('settings') });
  const search = r.target.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = async (v: string) => {
    search.value = v;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  };
  return { ...r, search, type };
}

describe('SettingsOverlay', () => {
  it('lists every page and starts on Appearance', () => {
    const { target } = mountSettings();
    const names = [...target.querySelectorAll('nav .item .t')].map((e) => e.textContent);
    expect(names).toEqual(['Appearance', 'Agent config', 'Models', 'Skills', 'Usage', 'Connection', 'Shortcuts']);
    expect(target.querySelector('.page-title')?.textContent).toBe('Appearance');
    expect(target.querySelector('nav [aria-current="page"]')).not.toBeNull();
  });

  it('search shows matching settings with their page and hides the nav', async () => {
    const { target, type } = mountSettings();
    await type('density');
    const hits = [...target.querySelectorAll('[role="option"]')];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.textContent).toContain('Appearance');
    expect(target.querySelector('nav')).toBeNull();
  });

  it('Enter on a hit jumps to its page and clears the search', async () => {
    const { target, type, search } = mountSettings();
    await type('keyboard');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(search.value).toBe('');
    expect(target.querySelector('.page-title')?.textContent).toBe('Shortcuts');
  });

  it('shows an empty state for a search with no matches', async () => {
    const { target, type } = mountSettings();
    await type('zzzzqqq');
    expect(target.querySelector('.none')?.textContent).toContain('Nothing matches "zzzzqqq"');
  });

  it('first Escape in the search clears it, and does not bubble to close', async () => {
    const { type, search } = mountSettings();
    await type('theme');
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    search.dispatchEvent(e);
    document.removeEventListener('keydown', seen);
    await settle();
    expect(search.value).toBe('');
    expect(seen).not.toHaveBeenCalled();
  });

  it('opens at the page the palette asked for', async () => {
    ui.settingsAt = { page: 'connection' };
    const { target } = mountSettings();
    await settle();
    expect(target.querySelector('.page-title')?.textContent).toBe('Connection');
    expect(ui.settingsAt).toBeNull();
  });

  it('closes freely when the agent config is clean', () => {
    mountSettings();
    expect(ui.tryClose('settings')).toBe(true);
    expect(ui.isOpen('settings')).toBe(false);
  });

  it('asks before closing with unsaved config, and Keep editing leaves it open', async () => {
    const { target } = mountSettings();
    await configDraft.load();
    configDraft.text = 'a: 2\n';
    expect(ui.tryClose('settings')).toBe(false);
    expect(ui.isOpen('settings')).toBe(true);
    expect(ui.confirmRequest?.title).toBe('Discard unsaved changes');
    ui.answerConfirm(false);
    await settle();
    expect(ui.isOpen('settings')).toBe(true);
    expect(configDraft.dirty).toBe(true);
    expect(target.querySelector('dialog')).not.toBeNull();
  });

  it('Discard throws the edits away and closes', async () => {
    mountSettings();
    await configDraft.load();
    configDraft.text = 'a: 2\n';
    ui.tryClose('settings');
    ui.answerConfirm(true);
    await settle();
    expect(ui.isOpen('settings')).toBe(false);
    expect(configDraft.dirty).toBe(false);
  });

  it('the Agent config page edits the shared draft and saves with Ctrl+S', async () => {
    const save = vi.spyOn(host, 'saveConfig').mockResolvedValue({ ok: true } as never);
    const { target } = mountSettings();
    buttonNamed(target, /^Agent config/)!.click();
    await settle();
    await settle();
    const area = target.querySelector('textarea')!;
    expect(area.value).toBe('a: 1\n');
    area.value = 'a: 5\n';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(save).toHaveBeenCalledWith('a: 5\n');
  });
});
