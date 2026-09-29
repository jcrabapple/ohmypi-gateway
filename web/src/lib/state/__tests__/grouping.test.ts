import { describe, expect, it } from 'vitest';
import type { SavedSession, SessionInfo } from '../../api/types';
import { groupSessions, historyBucket } from '../grouping';

const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();
const sec = (d: Date) => d.getTime() / 1000;

function live(gwId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    gwId, cwd: '/x', approvalMode: 'yolo', resumedFrom: null, ompSessionId: null, ompSessionFile: null,
    ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false,
    exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0,
    contextUsage: null, lastEventSeq: 0, pendingUi: [], ...over,
  };
}

function saved(file: string, mtime: number, over: Partial<SavedSession> = {}): SavedSession {
  return { file, mtime, sizeBytes: 1, cwdFolder: 'f', cwd: null, title: file, running: false, ...over };
}

describe('groupSessions', () => {
  it('splits live sessions into needs you, running and idle', () => {
    const g = groupSessions(
      [
        live('a', { isStreaming: true }),
        live('b', { pendingUi: [{ id: '1', method: 'confirm' }] }),
        live('c'),
        live('d', { isStreaming: true, pendingUi: [{ id: '2', method: 'select' }] }),
        live('gone', { exited: true }),
      ],
      [],
      NOW,
    );
    expect(g.needsYou.map((s) => s.gwId)).toEqual(['b', 'd']);
    expect(g.running.map((s) => s.gwId)).toEqual(['a']);
    expect(g.idle.map((s) => s.gwId)).toEqual(['c']);
  });

  it('reads a session with an in_progress todo as working even when not streaming', () => {
    const g = groupSessions([live('plan', { isStreaming: false }), live('calm')], [], NOW, new Set(['plan']));
    expect(g.running.map((s) => s.gwId)).toEqual(['plan']);
    expect(g.idle.map((s) => s.gwId)).toEqual(['calm']);
  });

  it('pendingUi still wins over todo activity', () => {
    const g = groupSessions([live('both', { pendingUi: [{ id: '1', method: 'confirm' }] })], [], NOW, new Set(['both']));
    expect(g.needsYou.map((s) => s.gwId)).toEqual(['both']);
    expect(g.running).toEqual([]);
  });

  it('groups pinned sessions as Ready for review between Needs you and Running', () => {
    const g = groupSessions(
      [
        live('idle1'),
        live('run1', { isStreaming: true }),
        live('pinned1'),
        live('pinned2'),
        live('need1', { pendingUi: [{ id: 'u', method: 'confirm' }] }),
      ],
      [],
      NOW,
      new Set(),
      new Set(['pinned1', 'pinned2']),
    );
    expect(g.needsYou.map((s) => s.gwId)).toEqual(['need1']);
    expect(g.review.map((s) => s.gwId)).toEqual(['pinned1', 'pinned2']);
    expect(g.running.map((s) => s.gwId)).toEqual(['run1']);
    expect(g.idle.map((s) => s.gwId)).toEqual(['idle1']);
  });

  it('working outranks the pin: a flagged streaming or todo-active session stays in Running', () => {
    const g = groupSessions([live('both', { isStreaming: true })], [], NOW, new Set(), new Set(['both']));
    expect(g.running.map((s) => s.gwId)).toEqual(['both']);
    expect(g.review).toEqual([]);

    const todo = groupSessions([live('both')], [], NOW, new Set(['both']), new Set(['both']));
    expect(todo.running.map((s) => s.gwId)).toEqual(['both']);
    expect(todo.review).toEqual([]);
  });

  it('pendingUi outranks the review pin', () => {
    const g = groupSessions([live('pinned', { pendingUi: [{ id: '1', method: 'select' }] })], [], NOW, new Set(), new Set(['pinned']));
    expect(g.needsYou.map((s) => s.gwId)).toEqual(['pinned']);
    expect(g.review).toEqual([]);
  });

  it('buckets history by local calendar day, newest first', () => {
    const at = (days: number, h = 12) => new Date(2026, 8, 29 - days, h, 0, 0);
    const g = groupSessions(
      [],
      [
        saved('old', sec(at(30))),
        saved('week', sec(at(5))),
        saved('yest', sec(at(1, 23))),
        saved('today-early', sec(at(0, 1))),
        saved('today-late', sec(at(0, 14))),
      ],
      NOW,
    );
    expect(g.history.map((h) => h.key)).toEqual(['today', 'yesterday', 'week', 'older']);
    expect(g.history[0]!.items.map((s) => s.file)).toEqual(['today-late', 'today-early']);
    expect(g.history[0]!.label).toBe('Today');
  });

  it('omits empty buckets', () => {
    const g = groupSessions([], [saved('a', sec(new Date(2026, 8, 29, 9)))], NOW);
    expect(g.history.map((h) => h.key)).toEqual(['today']);
  });

  it('hides saved sessions that are live right now', () => {
    const g = groupSessions(
      [live('a', { ompSessionFile: '/s/one.jsonl' })],
      [saved('/s/one.jsonl', sec(new Date(2026, 8, 29, 9))), saved('/s/two.jsonl', sec(new Date(2026, 8, 29, 8))),
        saved('/s/three.jsonl', sec(new Date(2026, 8, 29, 7)), { running: true })],
      NOW,
    );
    expect(g.history[0]!.items.map((s) => s.file)).toEqual(['/s/two.jsonl']);
  });

  it('bucket edges', () => {
    expect(historyBucket(sec(new Date(2026, 8, 29, 0, 0, 0)), NOW)).toBe('today');
    expect(historyBucket(sec(new Date(2026, 8, 28, 23, 59, 59)), NOW)).toBe('yesterday');
    expect(historyBucket(sec(new Date(2026, 8, 22, 0, 0, 0)), NOW)).toBe('week');
    expect(historyBucket(sec(new Date(2026, 8, 21, 23, 59, 59)), NOW)).toBe('older');
  });
});
