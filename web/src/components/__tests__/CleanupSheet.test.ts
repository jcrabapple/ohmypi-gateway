import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import * as endpoints from '../../lib/api/endpoints';
import { sessionsStore } from '../../lib/state';
import CleanupSheet from '../CleanupSheet.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';
import type { SavedSession } from '../../lib/api/types';

afterEach(cleanup);

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
    const { target } = render(CleanupSheet, { onclose: () => {} });
    await settle();

    expect(target.querySelectorAll('.row')).toHaveLength(2);
    listIn(target).click();
    flushSync();
    const delBtn = buttonNamed(target, /Delete 1 selected/);
    expect(delBtn).toBeTruthy();
    delBtn!.click();
    flushSync();
    await settle();
    expect(del).toHaveBeenCalledWith('/s/a.jsonl');
    expect(refresh).toHaveBeenCalled();
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
});
