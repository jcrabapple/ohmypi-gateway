import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedSession, SessionInfo } from '../../lib/api/types';
import { storageKey } from '../../lib/platform/storage';
import { reviewed, sessionsStore } from '../../lib/state';
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
    row.querySelector<HTMLButtonElement>('button[aria-label="Row menu"]')!.click();
    await settle();
    expect([...target.querySelectorAll('button')].some((b) => b.textContent?.includes('Unpin'))).toBe(true);
  });

  it('offers Mark ready for review in unpinned rows and runs it', async () => {
    sessionsStore.live = [live('plain')];
    const { target } = render(Rail, {});
    target.querySelector<HTMLButtonElement>('button[aria-label="Row menu"]')!.click();
    await settle();
    const item = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Mark ready for review'));
    expect(item).toBeDefined();
    item!.click();
    await settle();
    expect(reviewed.needsReview.has('plain')).toBe(true);
    expect(JSON.parse(localStorage.getItem(storageKey('device', 'ompgw-needs-review'))!)).toEqual(['plain']);
  });
});
