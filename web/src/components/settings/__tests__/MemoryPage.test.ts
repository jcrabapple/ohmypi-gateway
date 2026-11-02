import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memory } from '../../../lib/api/endpoints';
import type { MemoryNote } from '../../../lib/api/types';
import { ui } from '../../../lib/state/ui.svelte';
import MemoryPage from '../MemoryPage.svelte';
import { buttonNamed, cleanup, render, settle } from '../../__tests__/mount';

const stats = {
  counts: { note: 8, skill: 28, tag: 15, edges: 31 },
  hot: [{ id: 'note-a', title: 'Restic backup pipeline' }],
  root: '/home/x/.omp/agent/memory',
  hasHotFile: true,
};

const note: MemoryNote = {
  id: 'note-a',
  title: 'Restic backup pipeline',
  tags: ['infra', 'backup'],
  links: ['skill:aurora'],
  body: 'nightly restic to s3',
  path: '/home/x/.omp/agent/memory/notes/note-a.md',
  tier: 'hot',
  archived: false,
  outgoing: [{ id: 'skill:aurora', kind: 'references' }],
  incoming: [{ id: 'note-b', kind: 'references' }],
};

beforeEach(() => {
  vi.spyOn(memory, 'stats').mockResolvedValue(stats);
  vi.spyOn(memory, 'notes').mockResolvedValue({
    query: '',
    notes: [{ id: 'note-a', title: 'Restic backup pipeline', kind: 'note', tier: 'hot', snippet: 'nightly restic' }],
  });
  vi.spyOn(memory, 'note').mockResolvedValue(note);
  vi.spyOn(memory, 'recall').mockResolvedValue({
    query: '',
    rows: [
      {
        id: 'e1', bank: 'proj-abc', content: 'retained fact', source: 'coding-agent-transcript',
        importance: 0.6, scope: 'bank', timestamp: '2026-10-26T08:27:28.259Z',
      },
    ],
    scanned: 1,
    banks: 1,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  ui.confirmRequest = null;
});

describe('MemoryPage', () => {
  it('shows graph counts, the hot list and the recent notes', async () => {
    const { target } = render(MemoryPage, {});
    await settle();
    const text = target.textContent!;
    expect(text).toContain('8 notes');
    expect(text).toContain('31 links');
    expect(text).toContain('Restic backup pipeline');
    expect(text).toContain('nightly restic');
  });

  it('opens a note into the editor, with tags and both edge directions', async () => {
    const { target } = render(MemoryPage, {});
    await settle();
    const row = buttonNamed(target, /Restic backup pipeline/);
    row!.click();
    await settle();
    expect(memory.note).toHaveBeenCalledWith('note-a');
    const body = target.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(body.value).toBe('nightly restic to s3');
    const inputs = [...target.querySelectorAll<HTMLInputElement>('input:not([type=search])')];
    expect(inputs.map((i) => i.value)).toContain('infra, backup');
    expect(target.textContent).toContain('skill:aurora');
    expect(target.textContent).toContain('Backlinks');
  });

  it('saves an edit and reports that the index was rebuilt', async () => {
    const save = vi.spyOn(memory, 'save').mockResolvedValue({
      id: 'note-a', created: false, path: '/x/note-a.md',
      index: { indexed: true, output: 'indexed: 51 nodes' }, note,
    });
    const { target } = render(MemoryPage, {});
    await settle();
    buttonNamed(target, /Restic backup pipeline/)!.click();
    await settle();
    const body = target.querySelector<HTMLTextAreaElement>('textarea')!;
    body.value = 'nightly restic to s3, verified';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    buttonNamed(target, 'Save')!.click();
    await settle();
    expect(save).toHaveBeenCalledWith({
      id: 'note-a',
      title: 'Restic backup pipeline',
      tags: ['infra', 'backup'],
      links: ['skill:aurora'],
      body: 'nightly restic to s3, verified',
    });
    expect(target.textContent).toContain('Updated and indexed');
  });

  it('says the note is saved when the index could not be rebuilt', async () => {
    vi.spyOn(memory, 'save').mockResolvedValue({
      id: 'note-new', created: true, path: '/x/note-new.md',
      index: { indexed: false, reason: 'oscar-memory not found on this host' }, note: null,
    });
    const { target } = render(MemoryPage, {});
    await settle();
    buttonNamed(target, 'New note')!.click();
    await settle();
    const title = target.querySelector<HTMLInputElement>('form input')!;
    title.value = 'Mead gravity log';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    buttonNamed(target, 'Save')!.click();
    await settle();
    expect(target.textContent).toContain('Index not rebuilt: oscar-memory not found on this host');
  });

  it('archives after the confirmation, and only then', async () => {
    const archive = vi.spyOn(memory, 'archive').mockResolvedValue({ ok: true });
    const { target } = render(MemoryPage, {});
    await settle();
    buttonNamed(target, /Restic backup pipeline/)!.click();
    await settle();
    buttonNamed(target, 'Archive')!.click();
    await settle();
    // The confirm dialog is up; nothing has been archived yet.
    expect(archive).not.toHaveBeenCalled();
    expect(ui.confirmRequest).not.toBeNull();
    ui.confirmRequest!.resolve(true);
    await settle();
    expect(archive).toHaveBeenCalledWith('note-a');
  });

  it('lists episodic rows read-only with their bank', async () => {
    const { target } = render(MemoryPage, {});
    await settle();
    const text = target.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('proj-abc');
    expect(text).toContain('retained fact');
    expect(text).toContain('across 1 bank');
  });

  it('keeps the newest result when an older search answers late', async () => {
    let landSlow: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      landSlow = resolve;
    });
    const notes = vi.spyOn(memory, 'notes');
    notes.mockClear();
    // initial '' search resolves at once, then 'alpha' hangs and 'beta' answers.
    notes.mockResolvedValueOnce({ query: '', notes: [] });
    notes.mockReturnValueOnce(slow as never);
    notes.mockResolvedValueOnce({
      query: 'beta',
      notes: [{ id: 'note-beta', title: 'Beta result', kind: 'note', tier: 'warm', snippet: '' }],
    });
    const { target } = render(MemoryPage, {});
    await settle();
    const input = target.querySelector<HTMLInputElement>('input[type=search]')!;
    const type = async (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    };
    await type('alpha');
    await new Promise((r) => setTimeout(r, 260)); // let the debounce fire
    await type('beta');
    await new Promise((r) => setTimeout(r, 260));
    await settle();
    expect(target.textContent).toContain('Beta result');
    // The stale 'alpha' answer lands last and must not replace the list.
    landSlow({ query: 'alpha', notes: [{ id: 'note-alpha', title: 'Alpha result', kind: 'note', tier: 'warm', snippet: '' }] });
    await settle();
    expect(target.textContent).toContain('Beta result');
    expect(target.textContent).not.toContain('Alpha result');
  });

  it('shows a skill hit but will not open it as a note', async () => {
    vi.spyOn(memory, 'notes').mockResolvedValue({
      query: 'aurora',
      notes: [{ id: 'skill:aurora', title: 'aurora', kind: 'skill', tier: 'warm', snippet: '' }],
    });
    const note = vi.spyOn(memory, 'note');
    const { target } = render(MemoryPage, {});
    await settle();
    const row = buttonNamed(target, /aurora/)!;
    expect(row.disabled).toBe(true);
    row.click();
    await settle();
    expect(note).not.toHaveBeenCalled();
  });

  it('reports a failed search instead of showing a stale list', async () => {
    vi.spyOn(memory, 'notes').mockRejectedValue(new Error('boom'));
    const { target } = render(MemoryPage, {});
    await settle();
    expect(target.textContent).toContain('Search failed');
  });
});
