import { afterEach, describe, expect, it, vi } from 'vitest';

// The component calls these as module bindings, so mock the module itself.
vi.mock('../../lib/api/endpoints', async (orig) => {
  const actual = await orig<typeof import('../../lib/api/endpoints')>();
  return { ...actual, sessionFiles: vi.fn(), fileUrl: actual.fileUrl };
});

import { sessionFiles, sessions } from '../../lib/api/endpoints';
import { session } from '../../lib/palette/__tests__/factories';
import { active } from '../../lib/state';
import FileBrowser from '../FileBrowser.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

const FILE = { name: 'report.md', path: 'report.md', isDir: false, size: 2048 };
const DIR = { name: 'build', path: 'build', isDir: true, size: null };

function open() {
  vi.spyOn(active, 'gwId', 'get').mockReturnValue('g1');
  active.info = session('g1', { cwd: '/work/proj' });
  return render(FileBrowser, { onclose: () => {} });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  active.info = null;
});

describe('FileBrowser', () => {
  it('lists folders and files, and links a download to the gateway path', async () => {
    vi.mocked(sessionFiles).mockResolvedValue([DIR, FILE]);
    const { target } = open();
    await settle();
    const text = target.textContent!;
    expect(text).toContain('report.md');
    expect(text).toContain('2.0 KB');
    const link = target.querySelector<HTMLAnchorElement>('a[download]')!;
    expect(link.getAttribute('href')).toContain('/api/sessions/g1/file?path=report.md');
    expect(link.textContent).toContain('Download');
  });

  it('descends into a folder and goes back up', async () => {
    vi.mocked(sessionFiles).mockResolvedValue([DIR, FILE]);
    const { target } = open();
    await settle();
    expect(sessionFiles).toHaveBeenLastCalledWith('g1', '');
    buttonNamed(target, /build/)!.click();
    await settle();
    expect(sessionFiles).toHaveBeenLastCalledWith('g1', 'build');
    buttonNamed(target, 'Up one folder')!.click();
    await settle();
    expect(sessionFiles).toHaveBeenLastCalledWith('g1', '');
  });

  it('uploads a chosen file into the current folder', async () => {
    vi.mocked(sessionFiles).mockResolvedValue([]);
    const upload = vi.spyOn(sessions, 'upload').mockResolvedValue({ name: 'notes.txt', path: 'notes.txt', size: 3 });
    const { target } = open();
    await settle();
    const input = target.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['abc'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(upload).toHaveBeenCalledWith('g1', file, '');
  });

  it('shows the empty folder state', async () => {
    vi.mocked(sessionFiles).mockResolvedValue([]);
    const { target } = open();
    await settle();
    expect(target.textContent).toContain('This folder is empty');
  });

  it('offers a retry when the folder cannot be read', async () => {
    vi.mocked(sessionFiles).mockRejectedValue(new Error('path escapes the session directory'));
    const { target } = open();
    await settle();
    expect(target.textContent).toContain('path escapes the session directory');
    expect(buttonNamed(target, 'Try again')).toBeDefined();
  });
});
