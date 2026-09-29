import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../lib/api/types';
import { active, reviewed, ui } from '../../lib/state';
import SessionHeader from '../SessionHeader.svelte';
import { cleanup, render, settle } from './mount';

function info(gwId: string): SessionInfo {
  return {
    gwId, cwd: `/work/${gwId}`, approvalMode: 'yolo', resumedFrom: null, ompSessionId: null, ompSessionFile: null,
    ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false,
    exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0,
    contextUsage: null, lastEventSeq: 0, pendingUi: [],
  };
}

afterEach(() => {
  cleanup();
  active.close();
  reviewed.needsReview = new Set();
  reviewed.done = new Set();
  localStorage.clear();
  ui.toasts.forEach((t) => ui.dismissToast(t.id));
});

describe('SessionHeader review actions', () => {
  it('shows Mark done only while the open session is pinned, and marking done clears the pin with a toast', async () => {
    active.gwId = 'gw-h';
    active.info = info('gw-h');
    const { target } = render(SessionHeader, {});
    expect(target.querySelector('button.done')).toBeNull();

    reviewed.flag('gw-h');
    await settle();
    const done = target.querySelector<HTMLButtonElement>('button.done');
    expect(done).not.toBeNull();
    expect(done!.textContent).toContain('Mark done');

    done!.click();
    await settle();
    expect(reviewed.needsReview.has('gw-h')).toBe(false);
    expect(reviewed.has('gw-h')).toBe(true);
    expect(ui.toasts.some((t) => t.text === 'Marked done')).toBe(true);
    expect(target.querySelector('button.done')).toBeNull();
  });

  it('surfaces the pin toggle in the session menu and unpins a flagged session', async () => {
    active.gwId = 'gw-m';
    active.info = info('gw-m');
    reviewed.flag('gw-m');
    const { target } = render(SessionHeader, {});
    target.querySelector<HTMLButtonElement>('button[aria-label="Session menu"]')!.click();
    await settle();
    const unpin = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Unpin'));
    expect(unpin).toBeDefined();
    expect([...target.querySelectorAll('button')].some((b) => b.textContent?.includes('Mark ready for review'))).toBe(false);

    unpin!.click();
    await settle();
    expect(reviewed.needsReview.has('gw-m')).toBe(false);
  });
});
