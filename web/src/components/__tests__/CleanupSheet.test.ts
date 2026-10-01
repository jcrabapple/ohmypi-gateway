import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import * as endpoints from '../../lib/api/endpoints';
import { pins, sessionsStore, ui } from '../../lib/state';
import CleanupSheet from '../CleanupSheet.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';
import type { SavedSession } from '../../lib/api/types';

afterEach(() => {
  cleanup();
  pins.clear();
});

function saved(over: Partial<SavedSession> = {}): SavedSession {
  return {
    file: '/s/a.jsonl',
    mtime: Date.now() / 1000,
    sizeBytes: 4096,
    cwdFolder: 'proj',
    cwd: '/home/me/proj',
    title: 'fix the solver loop',
    running: false,
    ...over,
  };
}

function listIn(target: ParentNode): HTMLInputElement {
  const el = target.querySelector('input[type="checkbox"]') as HTMLInputElement;
  if (!el) throw new Error('no checkbox');
  return el;
}

describe('CleanupSheet', () => {
  it('lists saved sessions, selects, deletes them and refreshes', async () => {
    sessionsStore.saved = [saved(), saved({ file: '/s/b.jsonl', title: 'real work', cwdFolder: 'other' })];
    const del = vi.spyOn(endpoints.sessions, 'deleteSaved').mockResolvedValue({ ok: true });
    const refresh = vi.spyOn(sessionsStore, 'refresh').mockResolvedValue();
    vi.spyOn(ui, 'confirm').mockResolvedValue(true);
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();

    expect(target.querySelectorAll('.row')).toHaveLength(2);
    listIn(target).click();
    flushSync();
    const delBtn = buttonNamed(target, /Delete 1 selected/);
    expect(delBtn).toBeTruthy();
    delBtn!.click();
    await settle();
    expect(del).toHaveBeenCalledWith('/s/a.jsonl');
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps failed deletions selected and confirms first', async () => {
    sessionsStore.saved = [saved({ file: '/s/a.jsonl', title: 'one' }), saved({ file: '/s/b.jsonl', title: 'two' })];
    const del = vi.spyOn(endpoints.sessions, 'deleteSaved')
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('that session is running; stop it first'));
    const confirmSpy = vi.spyOn(ui, 'confirm').mockResolvedValue(true);
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();
    target.querySelectorAll('input[type="checkbox"]').forEach((c) => {
      (c as HTMLInputElement).click();
      flushSync();
    });
    buttonNamed(target, /Delete 2 selected/)!.click();
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(2);
    // the failed one stays selected for retry
    expect(target.querySelector('input[type="checkbox"]:checked')).toBeTruthy();
  });

  it('does not delete when confirmation is dismissed', async () => {
    const del = vi.spyOn(endpoints.sessions, 'deleteSaved').mockResolvedValue({ ok: true });
    vi.spyOn(ui, 'confirm').mockResolvedValue(false);
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();
    listIn(target).click();
    flushSync();
    buttonNamed(target, /Delete 1 selected/)!.click();
    await settle();
    expect(del).not.toHaveBeenCalled();
  });

  it('age filter hides recent sessions', async () => {
    sessionsStore.saved = [
      saved({ file: '/s/old.jsonl', title: 'ancient', mtime: Date.now() / 1000 - 60 * 86400 }),
      saved({ file: '/s/new.jsonl', title: 'fresh' }),
    ];
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();
    expect(target.querySelectorAll('.row')).toHaveLength(2);
    buttonNamed(target, '30d')!.click();
    flushSync();
    await settle();
    expect(target.querySelectorAll('.row')).toHaveLength(1);
    expect(target.textContent).toContain('ancient');
  });

  it('running sessions are never offered', async () => {
    sessionsStore.saved = [saved({ running: true, title: 'busy one' })];
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();
    expect(target.querySelectorAll('.row')).toHaveLength(0);
    expect(target.textContent).toContain('Nothing matches');
  });

  it('pinned sessions are never offered for cleanup', async () => {
    pins.files = new Set(['/s/pinned.jsonl']);
    sessionsStore.saved = [
      saved({ file: '/s/pinned.jsonl', title: 'pinned one', cwdFolder: 'keep' }),
      saved({ file: '/s/free.jsonl', title: 'free to delete', cwdFolder: 'keep' }),
    ];
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();
    expect(target.querySelectorAll('.row')).toHaveLength(1);
    expect(target.textContent).not.toContain('pinned one');
  });
});
