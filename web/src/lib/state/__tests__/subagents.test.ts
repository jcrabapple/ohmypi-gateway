import { afterEach, describe, expect, it } from 'vitest';
import type { OmpEvent, SubagentLifecycleInfo, SubagentProgressFrame } from '../../api/types';
import { subagents } from '../subagents.svelte';

afterEach(() => {
  subagents.clear();
});

function feedProgress(payload: SubagentProgressFrame): void {
  const ev: OmpEvent = { type: 'subagent_progress', payload };
  subagents.feed(ev);
}

function feedLifecycle(payload: SubagentLifecycleInfo): void {
  const ev: OmpEvent = { type: 'subagent_lifecycle', payload };
  subagents.feed(ev);
}

// Live probe 2026-09-29: payload.id is absent on early frames, the id lives in
// payload.progress.id and the merge key is progress.id ?? `#index`.
describe('subagents store fold', () => {
  it('merges progress frames by progress.id, newest fields win', () => {
    feedProgress({ index: 3, agent: 'explore', task: 'map the surface', progress: {
      id: 'sa1', index: 3, agent: 'explore', status: 'running', task: 'map the surface', tokens: 120,
    } });
    feedProgress({ index: 3, progress: {
      id: 'sa1', index: 3, status: 'running', tokens: 400, cost: 0.02, currentTool: 'read',
    } });
    expect(subagents.total).toBe(1);
    const row = subagents.rows[0]!;
    expect(row.key).toBe('sa1');
    expect(row.agent).toBe('explore');
    expect(row.task).toBe('map the surface');
    expect(row.tokens).toBe(400);
    expect(row.cost).toBe(0.02);
    expect(row.currentTool).toBe('read');
    expect(subagents.running).toBe(1);
    expect(subagents.failed).toBe(0);
  });

  it('falls back to a #index key while progress.id is absent', () => {
    feedProgress({ index: 5, agent: 'fix', progress: { index: 5, status: 'running' } });
    feedProgress({ index: 5, progress: { index: 5, status: 'completed', tokens: 9 } });
    expect(subagents.total).toBe(1);
    expect(subagents.rows[0]!.key).toBe('#5');
    expect(subagents.rows[0]!.status).toBe('completed');
    expect(subagents.rows[0]!.agent).toBe('fix');
  });

  it('migrates a #index row to progress.id when an id arrives later', () => {
    feedProgress({ index: 5, agent: 'fix', progress: { index: 5, status: 'running' } });
    expect(subagents.total).toBe(1);
    expect(subagents.rows[0]!.key).toBe('#5');
    feedProgress({ index: 5, progress: { id: 'sa5', index: 5, status: 'running', tokens: 50 } });
    expect(subagents.total).toBe(1);
    expect(subagents.rows[0]!.key).toBe('sa5');
    expect(subagents.rows[0]!.id).toBe('sa5');
    expect(subagents.rows[0]!.agent).toBe('fix');
    expect(subagents.rows[0]!.tokens).toBe(50);
  });

  it('sorts by index and keeps unknown-index rows in arrival order after them', () => {
    feedProgress({ index: 2, progress: { id: 'b', index: 2, status: 'running' } });
    feedProgress({ progress: { id: 'late', status: 'running' } });
    feedProgress({ index: 1, progress: { id: 'a', index: 1, status: 'running' } });
    expect(subagents.rows.map((r) => r.key)).toEqual(['a', 'b', 'late']);
  });

  it('follows lifecycle transitions without regressing a terminal row', () => {
    feedProgress({ index: 1, progress: { id: 's1', index: 1, status: 'running', currentTool: 'bash' } });
    feedLifecycle({ id: 's1', agent: 'explore', status: 'completed', index: 1 });
    let row = subagents.rows[0]!;
    expect(row.status).toBe('completed');
    expect(row.currentTool).toBe('');
    expect(row.agent).toBe('explore');
    feedLifecycle({ id: 's1', status: 'started', index: 1 });
    expect(subagents.rows[0]!.status).toBe('completed');
    // Late progress frame must not regress terminal row
    feedProgress({ index: 1, progress: { id: 's1', index: 1, status: 'running', currentTool: 'bash' } });
    expect(subagents.rows[0]!.status).toBe('completed');
    expect(subagents.rows[0]!.currentTool).toBe('');

    feedProgress({ index: 2, progress: { id: 's2', index: 2 } });
    expect(subagents.rows[1]!.status).toBe('pending');
    feedLifecycle({ id: 's2', status: 'started', index: 2 });
    expect(subagents.rows[1]!.status).toBe('running');
    row = subagents.rows[1]!;
    expect(row.description).toBe('');
    feedLifecycle({ id: 's2', status: 'started', description: 'probe the api', index: 2 });
    expect(subagents.rows[1]!.description).toBe('probe the api');
    feedLifecycle({ id: 's2', status: 'aborted', index: 2 });
    expect(subagents.rows[1]!.status).toBe('aborted');
    feedProgress({ index: 2, progress: { id: 's2', index: 2, status: 'running' } });
    expect(subagents.rows[1]!.status).toBe('aborted');
  });

  it('counts failed rows and keeps the retry badge state', () => {
    feedProgress({ index: 1, progress: {
      id: 'r1', index: 1, status: 'running', currentTool: 'edit', retryState: { attempt: 2, maxAttempts: 3 },
    } });
    expect(subagents.rows[0]!.retry).toEqual({ attempt: 2, maxAttempts: 3 });
    feedProgress({ index: 1, progress: { id: 'r1', index: 1, status: 'failed' } });
    expect(subagents.failed).toBe(1);
    expect(subagents.running).toBe(0);
    expect(subagents.rows[0]!.currentTool).toBe('');
    expect(subagents.rows[0]!.retry).toEqual({ attempt: 2, maxAttempts: 3 });
  });

  it('clears on session switch', () => {
    feedProgress({ index: 1, progress: { id: 'x', index: 1, status: 'running' } });
    expect(subagents.hasAny).toBe(true);
    subagents.clear();
    expect(subagents.rows).toEqual([]);
    expect(subagents.hasAny).toBe(false);
  });

  it('seeds the registry snapshot leniently, list or {subagents}', () => {
    subagents.seed({ subagents: [{ id: 'x1', index: 0, status: 'completed', tokens: 5 }] });
    expect(subagents.rows[0]!.key).toBe('x1');
    subagents.seed([{ id: 'x2', index: 1, status: 'running', agent: 'fix', progress: { tokens: 7 } }]);
    expect(subagents.total).toBe(2);
    expect(subagents.rows[1]!.tokens).toBe(7);
    // Junk entries and junk envelopes are skipped, never thrown on.
    subagents.seed([null, 'nope', { index: 2 }]);
    subagents.seed(null);
    subagents.seed({ nothing: true });
    expect(subagents.total).toBe(3);
  });

  it('ignores frames that are not subagent events', () => {
    subagents.feed({ type: 'agent_start' });
    subagents.feed({ type: 'subagent_progress' });
    subagents.feed({ type: 'subagent_lifecycle' });
    expect(subagents.total).toBe(0);
  });
});
