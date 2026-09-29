import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { host } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { configDraft } from '../config-draft.svelte';
import { Loader } from '../loader.svelte';
import { settings } from '../settings.svelte';
import { ui } from '../ui.svelte';

afterEach(() => {
  while (ui.overlays.length) ui.close();
  ui.guard('settings', null);
  configDraft.discard();
});

describe('ui.guard and tryClose', () => {
  it('closes straight away without a guard', () => {
    ui.open('settings', null);
    expect(ui.tryClose('settings')).toBe(true);
    expect(ui.isOpen('settings')).toBe(false);
  });

  it('keeps the overlay open when the guard says no', () => {
    ui.open('settings', null);
    const guard = vi.fn(() => false);
    ui.guard('settings', guard);
    expect(ui.tryClose('settings')).toBe(false);
    expect(guard).toHaveBeenCalledOnce();
    expect(ui.isOpen('settings')).toBe(true);
  });

  it('lets the close through when the guard agrees, and stops guarding once removed', () => {
    ui.open('settings', null);
    ui.guard('settings', () => true);
    expect(ui.tryClose('settings')).toBe(true);
    ui.open('settings', null);
    ui.guard('settings', () => false);
    ui.guard('settings', null);
    expect(ui.tryClose()).toBe(true);
  });

  it('Escape goes through the guard of the top overlay only', () => {
    ui.open('settings', null);
    ui.open('palette', null);
    ui.guard('settings', () => false);
    expect(ui.escape()).toBe(true);
    expect(ui.top).toBe('settings');
    expect(ui.escape()).toBe(true);
    expect(ui.top).toBe('settings');
  });
});

describe('settings accent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => settings.reset());

  it('sets a readable --accent-ink for a custom accent and clears it again', () => {
    const root = document.createElement('html');
    settings.update({ accent: '#ffff00' });
    settings.apply(root);
    expect(root.style.getPropertyValue('--accent')).toBe('#ffff00');
    expect(root.style.getPropertyValue('--accent-ink')).toBe('#000000');
    settings.update({ accent: '#1e3a8a' });
    settings.apply(root);
    expect(root.style.getPropertyValue('--accent-ink')).toBe('#ffffff');
    settings.update({ accent: null });
    settings.apply(root);
    expect(root.style.getPropertyValue('--accent-ink')).toBe('');
  });
});

describe('Loader', () => {
  it('goes loading, then ready', async () => {
    const l = new Loader<number>();
    const p = l.run(async () => 3);
    expect(l.loading).toBe(true);
    expect(await p).toBe(3);
    expect(l.data).toBe(3);
    expect(l.loading).toBe(false);
    expect(l.error).toBeNull();
  });

  it('keeps old data on screen while refreshing and after a failure', async () => {
    const l = new Loader<number>();
    await l.run(async () => 1);
    const p = l.run(() => new Promise<number>((_, rej) => setTimeout(() => rej(new Error('nope')), 0)));
    expect(l.refreshing).toBe(true);
    await p;
    expect(l.data).toBe(1);
    expect(l.error).toBe('nope');
    expect(l.refreshing).toBe(false);
  });

  it('ignores a stale response that lands after a newer run', async () => {
    const l = new Loader<string>();
    let slow!: (v: string) => void;
    const first = l.run(() => new Promise<string>((r) => (slow = r)));
    await l.run(async () => 'new');
    slow('old');
    await first;
    expect(l.data).toBe('new');
  });
});

describe('config draft', () => {
  beforeEach(() => {
    vi.spyOn(host, 'config').mockResolvedValue({ raw: 'a: 1\n', parsed: { a: 1 }, file: '/home/x/config.yml' });
  });

  it('loads the file and is clean', async () => {
    await configDraft.load();
    expect(configDraft.text).toBe('a: 1\n');
    expect(configDraft.dirty).toBe(false);
    expect(configDraft.file).toBe('/home/x/config.yml');
  });

  it('is dirty after an edit and clean again after revert', async () => {
    await configDraft.load();
    configDraft.text = 'a: 2\n';
    expect(configDraft.dirty).toBe(true);
    configDraft.revert();
    expect(configDraft.text).toBe('a: 1\n');
    expect(configDraft.dirty).toBe(false);
  });

  it('does not reload over unsaved edits', async () => {
    await configDraft.load();
    configDraft.text = 'edited';
    await configDraft.load();
    expect(configDraft.text).toBe('edited');
  });

  it('saves as YAML and reports the gateway note', async () => {
    const save = vi.spyOn(host, 'saveConfig').mockResolvedValue({ ok: true, note: 'Applies to new sessions.' });
    await configDraft.load();
    configDraft.text = 'a: 2\n';
    expect(await configDraft.save()).toBe(true);
    expect(save).toHaveBeenCalledWith('a: 2\n');
    expect(configDraft.dirty).toBe(false);
    expect(configDraft.savedNote).toBe('Applies to new sessions.');
  });

  it("shows the gateway's validation message and stays dirty when the save is refused", async () => {
    vi.spyOn(host, 'saveConfig').mockRejectedValue(new ApiError(400, 'invalid YAML: line 2, column 3'));
    await configDraft.load();
    configDraft.text = 'a: [';
    expect(await configDraft.save()).toBe(false);
    expect(configDraft.saveError).toBe('invalid YAML: line 2, column 3');
    expect(configDraft.dirty).toBe(true);
  });

  it('surfaces a load failure and allows another try', async () => {
    vi.spyOn(host, 'config').mockRejectedValueOnce(new Error('gateway down'));
    await configDraft.load();
    expect(configDraft.loadError).toBe('gateway down');
    expect(configDraft.saved).toBeNull();
    await configDraft.load();
    expect(configDraft.saved).toBe('a: 1\n');
    expect(configDraft.loadError).toBeNull();
  });

  it('carries a parseError from the gateway', async () => {
    vi.spyOn(host, 'config').mockResolvedValue({ raw: 'x: [', parsed: null, parseError: 'bad flow sequence' });
    await configDraft.load();
    expect(configDraft.parseError).toBe('bad flow sequence');
  });
});
