import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import * as endpoints from '../../lib/api/endpoints';
import { ApiError } from '../../lib/api/client';
import type { FsDirs } from '../../lib/api/types';
import NewSessionSheet from '../NewSessionSheet.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function listing(path: string, names: string[], over: Partial<FsDirs> = {}): FsDirs {
  return {
    path,
    parent: path === '/' ? null : path.replace(/\/[^/]+$/, '') || '/',
    home: '/home/me',
    dirs: names.map((n) => ({ name: n, path: `${path === '/' ? '' : path}/${n}` })),
    truncated: false,
    ...over,
  };
}

function folderInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[id$="-cwd"]');
  if (!el) throw new Error('no folder input');
  return el;
}

function folderButtons(): string[] {
  const region = document.querySelector('[aria-label="Folder picker"]');
  if (!region) return [];
  return [...region.querySelectorAll('button.dir')].map((b) => b.textContent!.trim());
}

describe('NewSessionSheet folder picker', () => {
  it('opens on the typed folder, lists its subfolders, and drills in', async () => {
    const browse = vi.spyOn(endpoints, 'browseDirs').mockImplementation(async (p: string) =>
      p === '/home/me/projects' ? listing('/home/me/projects', ['alpha', 'beta']) : listing('/home/me/projects/alpha', ['src']),
    );
    render(NewSessionSheet, { onclose: () => {} });
    await settle();
    folderInput().value = '/home/me/projects';
    folderInput().dispatchEvent(new Event('input'));
    flushSync();

    buttonNamed(document.body, 'Browse')!.click();
    await settle();
    expect(browse).toHaveBeenLastCalledWith('/home/me/projects');
    expect(folderButtons()).toEqual(['alpha', 'beta']);

    document.querySelector<HTMLButtonElement>('button.dir[title="/home/me/projects/alpha"]')!.click();
    await settle();
    expect(browse).toHaveBeenLastCalledWith('/home/me/projects/alpha');
    expect(folderButtons()).toEqual(['src']);
  });

  it('"Use this folder" writes the open folder into the field and closes the picker', async () => {
    vi.spyOn(endpoints, 'browseDirs').mockResolvedValue(listing('/srv/work', ['app']));
    render(NewSessionSheet, { onclose: () => {} });
    await settle();
    buttonNamed(document.body, 'Browse')!.click();
    await settle();
    buttonNamed(document.body, 'Use this folder')!.click();
    await settle();
    expect(folderInput().value).toBe('/srv/work');
    expect(document.querySelector('[aria-label="Folder picker"]')).toBeNull();
    expect(buttonNamed(document.body, 'Browse')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('Up and Home navigate via the parent and "~"', async () => {
    const browse = vi.spyOn(endpoints, 'browseDirs').mockImplementation(async (p: string) =>
      p === '~' ? listing('/home/me', ['projects']) : listing('/srv/work', ['app']),
    );
    render(NewSessionSheet, { onclose: () => {} });
    await settle();
    buttonNamed(document.body, 'Browse')!.click();
    await settle();
    buttonNamed(document.body, 'Home')!.click();
    await settle();
    expect(browse).toHaveBeenLastCalledWith('~');
    expect(folderButtons()).toEqual(['projects']);
  });

  it('shows the gateway error and keeps "Use this folder" disabled', async () => {
    vi.spyOn(endpoints, 'browseDirs').mockRejectedValue(new ApiError(404, 'no such folder'));
    render(NewSessionSheet, { onclose: () => {} });
    await settle();
    buttonNamed(document.body, 'Browse')!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('no such folder');
    expect(buttonNamed(document.body, 'Use this folder')!.disabled).toBe(true);
  });
});
