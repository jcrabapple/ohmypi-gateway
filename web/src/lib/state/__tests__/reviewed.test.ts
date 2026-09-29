import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../api/types';
import { sessions as sessionsApi } from '../../api/endpoints';
import { storageKey } from '../../platform/storage';
import { active } from '../active.svelte';
import { ReviewedStore, reviewed } from '../reviewed.svelte';

const DONE_KEY = storageKey('device', 'ompgw-reviewed');
const REVIEW_KEY = storageKey('device', 'ompgw-needs-review');

function liveInfo(gwId: string): SessionInfo {
  return {
    gwId, cwd: `/work/${gwId}`, approvalMode: 'yolo', resumedFrom: null, ompSessionId: null, ompSessionFile: null,
    ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false,
    exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0,
    contextUsage: null, lastEventSeq: 0, pendingUi: [],
  };
}

beforeEach(() => localStorage.clear());

describe('reviewed store', () => {
  it('flags, unpins and persists the needs-review set', () => {
    reviewed.flag('gw-a');
    expect(reviewed.needsReview.has('gw-a')).toBe(true);
    expect(JSON.parse(localStorage.getItem(REVIEW_KEY)!)).toEqual(['gw-a']);

    reviewed.unflag('gw-a');
    expect(reviewed.needsReview.has('gw-a')).toBe(false);
    expect(JSON.parse(localStorage.getItem(REVIEW_KEY)!)).toEqual([]);
  });

  it('marks done, undoes, clears and persists the done set', () => {
    reviewed.markDone('gw-a');
    reviewed.markDone('gw-b');
    expect(reviewed.has('gw-a')).toBe(true);
    expect(JSON.parse(localStorage.getItem(DONE_KEY)!).sort()).toEqual(['gw-a', 'gw-b']);

    reviewed.undo('gw-a');
    expect(reviewed.has('gw-a')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DONE_KEY)!)).toEqual(['gw-b']);

    reviewed.clear();
    expect(reviewed.has('gw-b')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DONE_KEY)!)).toEqual([]);
  });

  it('loads persisted sets once at construction and resets on junk', () => {
    localStorage.setItem(DONE_KEY, '["kept"]');
    localStorage.setItem(REVIEW_KEY, '{"not":"an array"}');
    const store = new ReviewedStore();
    expect(store.has('kept')).toBe(true);
    expect(store.needsReview.size).toBe(0);

    localStorage.setItem(REVIEW_KEY, 'not json at all');
    expect(new ReviewedStore().needsReview.size).toBe(0);
  });

  it('clears the review pin when a prompt is sent from the session', async () => {
    vi.spyOn(sessionsApi, 'prompt').mockResolvedValue(liveInfo('gw-x'));
    reviewed.flag('gw-x');
    active.gwId = 'gw-x';
    try {
      expect(await active.send('again')).toBe(true);
      expect(reviewed.needsReview.has('gw-x')).toBe(false);
    } finally {
      active.close();
    }
  });

  it('keeps the pin when the send fails', async () => {
    vi.spyOn(sessionsApi, 'prompt').mockRejectedValue(new Error('gateway down'));
    reviewed.flag('gw-y');
    active.gwId = 'gw-y';
    try {
      expect(await active.send('again')).toBe(false);
      expect(reviewed.needsReview.has('gw-y')).toBe(true);
    } finally {
      active.close();
    }
  });
});
