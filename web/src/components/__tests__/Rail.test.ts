import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedSession, SessionInfo } from '../../lib/api/types';
import { storageKey } from '../../lib/platform/storage';
import { folderFilter, pins, reviewed, sessionsStore } from '../../lib/state';
import Rail from '../Rail.svelte';
import { cleanup, render, settle } from './mount';

function live(gwId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    gwId, cwd: `/work/${gwId}`, approvalMode: 'yolo', resumedFrom: null, ompSessionId: null, ompSessionFile: null,
    ompSessionName: null, model: null, advisor: false, thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false,
    exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0,
    contextUsage: null, lastEventSeq: 0, pendingUi: [], ...over,
  };
}

function saved(file: string, ageDays: number): SavedSession {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ageDays);
  return { file, mtime: d.getTime() / 1000, sizeBytes: 1, cwdFolder: '-work-x', cwd: null, title: `title ${file}`, running: false };
}

beforeEach(() => {
  sessionsStore.loaded = true;
  sessionsStore.error = null;
});
afterEach(() => {
  cleanup();
  sessionsStore.live = [];
  sessionsStore.saved = [];
  reviewed.needsReview = new Set();
  reviewed.done = new Set();
  pins.clear();
  folderFilter.showAll();
  localStorage.clear();
});

describe('Rail', () => {
  it('orders sections: Needs you, Running, Idle, then history by age', () => {
    sessionsStore.live = [
      live('idle1'),
      live('run1', { isStreaming: true }),
      live('need1', { pendingUi: [{ id: 'u', method: 'confirm' }] }),
    ];
    sessionsStore.saved = [saved('e', 30), saved('w', 3), saved('y', 1), saved('t', 0)];
    const { target } = render(Rail, {});
    const headings = [...target.querySelectorAll('h2')].map((h) => h.textContent?.replace(/\d+$/, '').trim());
    expect(headings).toEqual(['Needs you', 'Running', 'Idle', 'Today', 'Yesterday', 'Previous 7 days', 'Earlier']);
  });

  it('omits empty sections', () => {
    sessionsStore.live = [live('only')];
    sessionsStore.saved = [];
    const { target } = render(Rail, {});
    const headings = [...target.querySelectorAll('h2')].map((h) => h.textContent?.replace(/\d+$/, '').trim());
    expect(headings).toEqual(['Idle']);
  });

  it('marks the needs-you row and hides exited sessions', () => {
    sessionsStore.live = [live('dead', { exited: true }), live('need', { pendingUi: [{ id: 'u', method: 'select' }] })];
    const { target } = render(Rail, {});
    expect(target.textContent).toContain('need');
    expect(target.textContent).not.toContain('dead');
  });

  it('orders Ready for review below Needs you and gives pinned rows an Unpin action', async () => {
    sessionsStore.live = [live('pinned'), live('plain')];
    reviewed.flag('pinned');
    const { target } = render(Rail, {});
    const headings = [...target.querySelectorAll('h2')].map((h) => h.textContent?.replace(/\d+$/, '').trim());
    expect(headings).toEqual(['Ready for review', 'Idle']);
    expect(target.querySelector('.glyph.review')).not.toBeNull();

    const row = [...target.querySelectorAll('.row')].find((r) => r.textContent?.includes('pinned'))!;
    row.querySelector<HTMLButtonElement>('button[aria-label^="Session options for"]')!.click();
    await settle();
    expect([...target.querySelectorAll('button')].some((b) => b.textContent?.includes('Unpin'))).toBe(true);
  });

  it('offers Mark ready for review in unpinned rows and runs it', async () => {
    sessionsStore.live = [live('plain')];
    const { target } = render(Rail, {});
    target.querySelector<HTMLButtonElement>('button[aria-label^="Session options for"]')!.click();
    await settle();
    const item = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Mark ready for review'));
    expect(item).toBeDefined();
    item!.click();
    await settle();
    expect(reviewed.needsReview.has('plain')).toBe(true);
    expect(JSON.parse(localStorage.getItem(storageKey('device', 'ompgw-needs-review'))!)).toEqual(['plain']);
  });
});

describe('Rail pinned sessions', () => {
  it('renders pinned saved sessions in a Pinned section above history and offers unpin', async () => {
    sessionsStore.saved = [saved('/s/pin.jsonl', 2), saved('/s/other.jsonl', 10)];
    pins.toggle('/s/pin.jsonl');
    const { target } = render(Rail, {});
    const sections = [...target.querySelectorAll('h2.eyebrow span:first-child')].map((h) => h.textContent);
    expect(sections.indexOf('Pinned')).toBeGreaterThanOrEqual(0);
    expect(sections.indexOf('Pinned')).toBeLessThan(sections.indexOf('Earlier'));
    expect(target.textContent).toContain('title /s/pin.jsonl');
    const unpin = [...target.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('title /s/pin.jsonl'));
    expect(unpin).toBeTruthy();
    unpin!.click();
    await settle();
    const item = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Unpin from list'));
    expect(item).toBeTruthy();
    item!.click();
    await settle();
    expect(pins.isPinned('/s/pin.jsonl')).toBe(false);
  });

  it('does not show the empty state when only pinned sessions exist', () => {
    sessionsStore.saved = [saved('/s/pin.jsonl', 2)];
    pins.toggle('/s/pin.jsonl');
    const { target } = render(Rail, {});
    expect(target.textContent).not.toContain('No sessions yet');
    expect(target.textContent).toContain('Pinned');
  });
});

describe('Rail folder filter', () => {
  const inFolder = (file: string, cwd: string) => ({ ...saved(file, 0), cwd });
  const filterBtn = (t: HTMLElement) => t.querySelector<HTMLButtonElement>('button[aria-label^="Filter folders"]');
  const menuItem = (t: HTMLElement, text: string) =>
    [...t.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent?.includes(text));

  it('shows the filter button only when saved sessions span more than one folder', () => {
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/w/p'), inFolder('/s/b.jsonl', '/w/p')];
    const one = render(Rail, {});
    expect(filterBtn(one.target)).toBeNull();
    cleanup();
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/w/p'), inFolder('/s/b.jsonl', '/w/q')];
    const two = render(Rail, {});
    expect(filterBtn(two.target)).not.toBeNull();
  });

  it('a stale hidden key for a folder no longer listed does not light the button', () => {
    folderFilter.toggle('/gone');
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/w/p'), inFolder('/s/b.jsonl', '/w/q')];
    const { target } = render(Rail, {});
    expect(filterBtn(target)!.classList.contains('on')).toBe(false);
    expect(filterBtn(target)!.getAttribute('aria-label')).toBe('Filter folders');
  });

  it('counts only sessions the filter can hide (pinned ones always show)', async () => {
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/w/p'), inFolder('/s/b.jsonl', '/w/p'), inFolder('/s/c.jsonl', '/w/q')];
    pins.toggle('/s/a.jsonl');
    const { target } = render(Rail, {});
    filterBtn(target)!.click();
    await settle();
    expect(menuItem(target, 'p (1)')).toBeTruthy();
  });

  it('keeps the menu open across checkbox toggles; the button toggles it closed', async () => {
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/w/p'), inFolder('/s/b.jsonl', '/w/q'), inFolder('/s/c.jsonl', '/w/r')];
    const { target } = render(Rail, {});
    filterBtn(target)!.click();
    await settle();
    menuItem(target, 'p (1)')!.click();
    await settle();
    menuItem(target, 'q (1)')!.click();
    await settle();
    expect([...folderFilter.hidden].sort()).toEqual(['/w/p', '/w/q']);
    expect(menuItem(target, 'q (1)')?.getAttribute('aria-checked')).toBe('false');
    expect(filterBtn(target)!.getAttribute('aria-expanded')).toBe('true');
    filterBtn(target)!.click();
    await settle();
    expect(filterBtn(target)!.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides a folder from history, says so, and Show all brings it back', async () => {
    sessionsStore.saved = [
      inFolder('/s/keep.jsonl', '/w/projects'),
      inFolder('/s/cron1.jsonl', '/home/j'),
      inFolder('/s/cron2.jsonl', '/home/j'),
    ];
    const { target } = render(Rail, {});
    filterBtn(target)!.click();
    await settle();
    const item = menuItem(target, 'j (2)');
    expect(item?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item?.getAttribute('aria-checked')).toBe('true');
    item!.click();
    await settle();
    expect(folderFilter.isHidden('/home/j')).toBe(true);
    expect(target.textContent).not.toContain('title /s/cron1.jsonl');
    expect(target.textContent).toContain('title /s/keep.jsonl');
    expect(target.textContent).toContain('2 hidden by folder filter');
    expect(filterBtn(target)!.classList.contains('on')).toBe(true);

    [...target.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!.click();
    await settle();
    expect(folderFilter.hidden.size).toBe(0);
    expect(target.textContent).toContain('title /s/cron1.jsonl');
    expect(target.textContent).not.toContain('hidden by folder filter');
  });

  it('does not claim "No sessions yet" when everything is filtered out', () => {
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/home/j')];
    folderFilter.toggle('/home/j');
    const { target } = render(Rail, {});
    expect(target.textContent).not.toContain('No sessions yet');
    expect(target.textContent).toContain('1 hidden by folder filter');
    // The button stays reachable to undo, even with a single folder left.
    expect(filterBtn(target)).not.toBeNull();
  });

  it('disambiguates folders that share a basename with the full path', async () => {
    sessionsStore.saved = [inFolder('/s/a.jsonl', '/tmp'), inFolder('/s/b.jsonl', '/home/j/tmp')];
    const { target } = render(Rail, {});
    filterBtn(target)!.click();
    await settle();
    expect(menuItem(target, '/tmp (1)')).toBeTruthy();
    expect(menuItem(target, '/home/j/tmp (1)')).toBeTruthy();
  });
});
