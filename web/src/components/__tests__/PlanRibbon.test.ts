import { afterEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../../lib/api/types';
import { active, settings } from '../../lib/state';
import PlanRibbon from '../PlanRibbon.svelte';
import { cleanup, render, settle } from './mount';

const BLOCKED_ONLY = [
  {
    name: 'Tasks',
    tasks: [
      { content: 'Map the tool surface', status: 'completed' },
      { content: 'Write the parser', status: 'blocked', blocker: 'No parser spec anywhere' },
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
  cleanup();
  active.state = null;
  active.phase = 'idle';
  settings.update({ planPanelOpen: null });
});

describe('PlanRibbon', () => {
  it('is hidden without a plan or before the session is ready', () => {
    const { target } = render(PlanRibbon, {});
    expect(target.querySelector('.ribbon')).toBeNull();

    active.state = state(BLOCKED_ONLY);
    active.phase = 'loading';
    expect(target.querySelector('.ribbon')).toBeNull();
  });

  it('shows plan progress and the first 60 characters of the active task', () => {
    active.state = state([{ tasks: [{ content: 'x'.repeat(70), status: 'in_progress' }] }]);
    active.phase = 'ready';
    const { target } = render(PlanRibbon, {});
    const ribbon = target.querySelector('.ribbon')!;
    expect(ribbon.textContent?.replace(/\s+/g, ' ')).toContain('Plan 0/1');
    expect(ribbon.textContent).toContain(`${'x'.repeat(60)}…`);
    expect(ribbon.textContent).not.toContain('x'.repeat(61));
    expect(ribbon.classList.contains('blocked')).toBe(false);
  });

  it('tints the ribbon when the only active task is blocked', () => {
    active.state = state(BLOCKED_ONLY);
    active.phase = 'ready';
    const { target } = render(PlanRibbon, {});
    const ribbon = target.querySelector('.ribbon')!;
    expect(ribbon.classList.contains('blocked')).toBe(true);
    expect(ribbon.textContent).toContain('Write the parser');
  });

  it('shows All tasks complete when every task is done', () => {
    active.state = state([{ tasks: [{ content: 'Only step', status: 'completed' }] }]);
    active.phase = 'ready';
    const { target } = render(PlanRibbon, {});
    const ribbon = target.querySelector('.ribbon')!;
    expect(ribbon.textContent?.replace(/\s+/g, ' ')).toContain('All tasks complete');
    expect(ribbon.textContent).not.toContain('Plan 1/1');
    // The check icon replaces the target (no <circle> rings).
    expect(ribbon.querySelector('svg circle')).toBeNull();
  });

  it('opens the panel on click', async () => {
    settings.planPanelOpen = false;
    active.state = state(BLOCKED_ONLY);
    active.phase = 'ready';
    const { target } = render(PlanRibbon, {});
    (target.querySelector('.ribbon') as HTMLButtonElement).click();
    await settle();
    expect(settings.planPanelOpen).toBe(true);
  });
});
