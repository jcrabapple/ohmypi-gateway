import { afterEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../../lib/api/types';
import type { ToolItem } from '../../lib/transcript/types';
import { active } from '../../lib/state';
import { emptyTranscript } from '../../lib/transcript/reducer';
import PlanPanel from '../PlanPanel.svelte';
import { cleanup, render, settle } from './mount';

const PLAN = [
  {
    name: 'Tasks',
    tasks: [
      { content: 'Map the tool surface', status: 'completed' },
      { content: 'Write the parser', status: 'in_progress' },
      { content: 'Add tests', status: 'pending' },
      { content: 'Wire the plan', status: 'blocked', blocker: 'No parser spec anywhere' },
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

function runningTool(): ToolItem {
  return {
    id: 't1', kind: 'tool', toolCallId: 'c1', toolName: 'bash', args: undefined, summary: 'bun run test',
    output: '', status: 'running',
  };
}

afterEach(() => {
  cleanup();
  active.state = null;
  active.transcript = emptyTranscript();
});

describe('PlanPanel', () => {
  it('renders the plan tab with counts, progress and per-status rows', () => {
    active.state = state(PLAN);
    const { target } = render(PlanPanel, {});
    expect(target.textContent).toContain('1 of 4 complete');
    const bar = target.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuemax')).toBe('4');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    const tab = [...target.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes('Plan'));
    expect(tab?.textContent?.replace(/\s+/g, ' ')).toContain('1/4');
    expect(target.querySelector('li.st-completed')?.textContent).toContain('Map the tool surface');
    expect(target.querySelector('li.st-in_progress')?.textContent).toContain('Write the parser');
    expect(target.querySelector('li.st-pending')?.textContent).toContain('Add tests');
  });

  it('toggles the blocker text on a blocked row and nothing else', async () => {
    active.state = state(PLAN);
    const { target } = render(PlanPanel, {});
    const row = target.querySelector<HTMLButtonElement>('li.st-blocked button')!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(target.textContent).not.toContain('No parser spec anywhere');

    row.click();
    await settle();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(target.textContent).toContain('No parser spec anywhere');

    row.click();
    await settle();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(target.textContent).not.toContain('No parser spec anywhere');
  });

  it('keeps a blocked row without blocker text non-interactive', () => {
    active.state = state([{ name: 'Tasks', tasks: [{ content: 'Waiting on review', status: 'blocked' }] }]);
    const { target } = render(PlanPanel, {});
    const li = target.querySelector('li.st-blocked')!;
    expect(li.querySelector('button')).toBeNull();
    const row = li.querySelector('.row')!;
    expect(row.classList.contains('static')).toBe(true);
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    expect(row.textContent).toContain('Waiting on review');
    expect(row.textContent).toContain('Blocked');
  });

  it('falls back to the activity tab without a plan and disables the plan tab', () => {
    active.state = state([]);
    const { target } = render(PlanPanel, {});
    expect(target.textContent).toContain('No tools running');
    const planTab = [...target.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes('Plan'))!;
    expect((planTab as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists currently running tools in the activity tab', async () => {
    active.state = state(PLAN);
    active.transcript = { ...emptyTranscript(), items: [runningTool()] };
    const { target } = render(PlanPanel, {});
    expect(target.textContent).not.toContain('bash');

    const activity = [...target.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes('Activity'))!;
    (activity as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector('[role="tabpanel"][aria-labelledby="plan-tab-activity"]')?.textContent).toContain('bash');
    expect(target.querySelector('[role="tabpanel"][aria-labelledby="plan-tab-activity"]')?.textContent).toContain('bun run test');
  });

  it('derives reactively when the plan arrives late', async () => {
    active.state = state([]);
    const { target } = render(PlanPanel, {});
    expect(target.textContent).not.toContain('1 of 4 complete');

    active.state = state(PLAN);
    await settle();
    expect(target.textContent).toContain('1 of 4 complete');
  });
});
