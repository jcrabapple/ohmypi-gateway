import { afterEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../../api/types';
import { active } from '../active.svelte';
import { countDone, countTotal, hasActiveTodo, normalizePhases, pickActiveTask } from '../plan';
import { plan } from '../plan.svelte';

// Live capture from the gateway, 2026-09-29: ids absent, `blocked` carries a blocker string.
const CAPTURE = [
  {
    name: 'Tasks',
    tasks: [
      { content: 'Map the tool surface', status: 'completed' },
      { content: 'Write the parser', status: 'blocked', blocker: 'No parser spec anywhere: nothing to port.' },
      { content: 'Add tests', status: 'blocked', blocker: 'Depends on the parser existing' },
    ],
  },
];

function state(todoPhases: unknown): SessionState {
  return {
    model: null, thinkingLevel: '', isStreaming: false, isCompacting: false, steeringMode: '', followUpMode: '',
    interruptMode: '', sessionFile: 's.jsonl', sessionId: 'abc', autoCompactionEnabled: false,
    queuedMessageCount: 0, hasPendingAsyncWork: false, isSettled: true,
    todoPhases: todoPhases as SessionState['todoPhases'],
    fastModeEnabled: false, fastModeActive: false, tokensPerSecond: null, messageCount: 0, contextUsage: null,
  };
}

afterEach(() => {
  active.state = null;
});

describe('normalizePhases', () => {
  it('coerces the live capture shape', () => {
    const phases = normalizePhases(CAPTURE);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.name).toBe('Tasks');
    expect(phases[0]!.id).toBeUndefined();
    expect(phases[0]!.tasks.map((t) => t.status)).toEqual(['completed', 'blocked', 'blocked']);
    expect(phases[0]!.tasks[1]!.blocker).toContain('No parser spec');
    expect(phases[0]!.tasks[0]!.id).toBeUndefined();
  });

  it('maps unknown status to pending and drops junk entries', () => {
    const phases = normalizePhases([
      null,
      { name: 'Empty', tasks: [] },
      { name: 'Odd', tasks: [{ content: 'A', status: 'sideways' }, { blocker: 'no content' }, 'junk'] },
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.tasks).toEqual([{ id: undefined, content: 'A', status: 'pending', blocker: undefined }]);
  });

  it('tolerates null, undefined and non-array input', () => {
    expect(normalizePhases(null)).toEqual([]);
    expect(normalizePhases(undefined)).toEqual([]);
    expect(normalizePhases('nope')).toEqual([]);
  });
});

describe('derivations', () => {
  it('counts done and total, hasPlan true', () => {
    const phases = normalizePhases(CAPTURE);
    expect(countDone(phases)).toBe(1);
    expect(countTotal(phases)).toBe(3);
  });

  it('picks first in_progress, then pending, then blocked', () => {
    const blockedOnly = normalizePhases(CAPTURE);
    expect(pickActiveTask(blockedOnly)?.status).toBe('blocked');
    expect(pickActiveTask(blockedOnly)?.content).toBe('Write the parser');

    const withPending = normalizePhases([{ tasks: [{ content: 'P', status: 'pending' }, ...CAPTURE[0]!.tasks] }]);
    expect(pickActiveTask(withPending)?.content).toBe('P');

    const withActive = normalizePhases([{ tasks: [...CAPTURE[0]!.tasks, { content: 'Now', status: 'in_progress' }] }]);
    expect(pickActiveTask(withActive)?.content).toBe('Now');

    const allDone = normalizePhases([{ tasks: [{ content: 'D', status: 'completed' }] }]);
    expect(pickActiveTask(allDone)).toBeNull();
  });
});

describe('plan store', () => {
  it('derives from the active session state and resets with it', () => {
    active.state = state(CAPTURE);
    expect(plan.hasPlan).toBe(true);
    expect(plan.done).toBe(1);
    expect(plan.total).toBe(3);
    expect(plan.activeTask?.status).toBe('blocked');
    expect(plan.activeTask?.content).toBe('Write the parser');

    active.state = state([{ tasks: [{ content: 'Only pending', status: 'pending' }] }]);
    expect(plan.total).toBe(1);
    expect(plan.activeTask?.content).toBe('Only pending');

    active.state = null;
    expect(plan.phases).toEqual([]);
    expect(plan.hasPlan).toBe(false);
    expect(plan.activeTask).toBeNull();
  });

  it('treats todoPhases [] as no plan', () => {
    active.state = state([]);
    expect(plan.hasPlan).toBe(false);
  });

  // active.open() closes first, so this also covers switching to a different session:
  // without the reset the narrow-screen plan sheet would survive the switch.
  it('closes the narrow plan sheet on close()', () => {
    plan.sheet = true;
    active.close();
    expect(plan.sheet).toBe(false);
  });
});

describe('hasActiveTodo', () => {
  it('is true only for in_progress tasks', () => {
    expect(hasActiveTodo(state(CAPTURE))).toBe(false);
    expect(hasActiveTodo(state([{ tasks: [{ content: 'X', status: 'in_progress' }] }]))).toBe(true);
    expect(hasActiveTodo(state([]))).toBe(false);
    expect(hasActiveTodo(null)).toBe(false);
  });
});
