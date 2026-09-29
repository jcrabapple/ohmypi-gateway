import { afterEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../../lib/api/types';
import { active, plan, settings } from '../../lib/state';
import SessionView from '../SessionView.svelte';
import { cleanup, render, settle } from './mount';

const PLAN = [{ name: 'Tasks', tasks: [{ content: 'First step', status: 'in_progress' }] }];

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
  plan.sheet = false;
  settings.update({ planPanelOpen: null });
});

describe('SessionView plan integration', () => {
  it('mounts the side panel and the ribbon when a plan is open', async () => {
    settings.planPanelOpen = true;
    active.gwId = 'gw1';
    active.phase = 'ready';
    active.info = {
      gwId: 'gw1', cwd: '/work/x', approvalMode: 'yolo', resumedFrom: null, ompSessionId: null,
      ompSessionFile: null, ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false,
      idleSec: 0, exited: false, exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0,
      messageCount: 0, contextUsage: null, lastEventSeq: 0, pendingUi: [],
    };
    active.state = state(PLAN);
    const { target } = render(SessionView, { gwId: 'gw1' });
    await settle();
    expect(target.querySelector('aside.plan')).not.toBeNull();
    expect(target.querySelector('.scroller .lead .ribbon')).not.toBeNull();
    const toggle = target.querySelector<HTMLButtonElement>('button[aria-label="Plan"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('plan-panel');
    expect(target.querySelector('aside#plan-panel')).not.toBeNull();

    toggle.click();
    await settle();
    expect(settings.planPanelOpen).toBe(false);
    expect(target.querySelector('aside.plan')).toBeNull();
  });

  it('pins the plan ribbon lead to the top of the transcript scroller', async () => {
    settings.planPanelOpen = true;
    active.gwId = 'gw1';
    active.phase = 'ready';
    active.info = {
      gwId: 'gw1', cwd: '/work/x', approvalMode: 'yolo', resumedFrom: null, ompSessionId: null,
      ompSessionFile: null, ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false,
      idleSec: 0, exited: false, exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0,
      messageCount: 0, contextUsage: null, lastEventSeq: 0, pendingUi: [],
    };
    active.state = state(PLAN);
    const { target } = render(SessionView, { gwId: 'gw1' });
    await settle();
    const lead = target.querySelector<HTMLElement>('.scroller .lead');
    expect(lead).not.toBeNull();
    // happy-dom does not cascade author stylesheets into getComputedStyle, so assert the rule
    // the component injects instead of the computed value.
    const rule = [...document.styleSheets]
      .flatMap((s) => [...s.cssRules])
      .find(
        (r): r is CSSStyleRule =>
          r instanceof CSSStyleRule && r.selectorText?.includes('.lead') === true && r.style.position === 'sticky',
      );
    expect(rule).toBeDefined();
    expect(rule!.style.top).toBe('0px');
    expect(rule!.style.zIndex).toBe('2');
  });
});
