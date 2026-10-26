import { describe, expect, it } from 'vitest';
import type { ExternalSession, SavedSession, SessionInfo } from '../../api/types';
import { groupSessions } from '../grouping';

const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();

function ext(instanceId: string, over: Partial<ExternalSession> = {}): ExternalSession {
  return {
    kind: 'external',
    instanceId,
    generation: 1,
    pid: 100,
    sessionId: null,
    title: null,
    cwd: '/x',
    model: null,
    startedAt: NOW - 60_000,
    participants: 0,
    access: 'view',
    busy: null,
    inputRequired: false,
    ask: null,
    lastSeenAt: NOW,
    stale: false,
    ...over,
  };
}

describe('groupSessions external rows', () => {
  it('orders asking rows oldest ask first, tie-broken by instanceId', () => {
    const g = groupSessions([], [], NOW, new Set(), new Set(), new Set(), new Set(), [
      ext('b', { inputRequired: true, ask: { requestId: '2', since: NOW - 2000 } }),
      ext('a', { inputRequired: true, ask: { requestId: '1', since: NOW - 2000 } }),
      ext('c', { inputRequired: true, ask: { requestId: '3', since: NOW - 5000 } }),
    ]);
    expect(g.externalNeedsYou.map((e) => e.instanceId)).toEqual(['c', 'a', 'b']);
    expect(g.externalRest).toEqual([]);
  });

  it('orders the rest newest first with stale last, tie-broken by instanceId', () => {
    const g = groupSessions([], [], NOW, new Set(), new Set(), new Set(), new Set(), [
      ext('b', { startedAt: NOW - 2000 }),
      ext('a', { startedAt: NOW - 2000 }),
      ext('old', { startedAt: NOW - 9000 }),
      ext('gone', { startedAt: NOW - 1000, stale: true }),
    ]);
    expect(g.externalRest.map((e) => e.instanceId)).toEqual(['a', 'b', 'old', 'gone']);
    expect(g.externalNeedsYou).toEqual([]);
  });

  it('a stale asker still lands in externalNeedsYou', () => {
    const g = groupSessions([], [], NOW, new Set(), new Set(), new Set(), new Set(), [
      ext('q', { inputRequired: true, ask: { requestId: 'q', since: NOW - 1000 }, stale: true }),
    ]);
    expect(g.externalNeedsYou.map((e) => e.instanceId)).toEqual(['q']);
    expect(g.externalRest).toEqual([]);
  });

  it('passing no external array leaves the previous groups identical', () => {
    const live: SessionInfo[] = [{
      gwId: 'l', cwd: '/x', approvalMode: 'yolo', resumedFrom: null, ompSessionId: null,
      ompSessionFile: null, ompSessionName: null, model: null, advisor: false,
      thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false, exitCode: null,
      protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0,
      contextUsage: null, lastEventSeq: 0, pendingUi: [],
    }];
    const saved: SavedSession[] = [{
      file: '/a.jsonl', mtime: NOW / 1000, sizeBytes: 1, cwdFolder: 'f', cwd: null,
      title: 'a', running: false,
    }];
    const before = groupSessions(live, saved, NOW);
    const after = groupSessions(live, saved, NOW, new Set(), new Set(), new Set(), new Set(), []);
    expect(after).toEqual(before);
    expect(after.externalNeedsYou).toEqual([]);
    expect(after.externalRest).toEqual([]);
  });
});
