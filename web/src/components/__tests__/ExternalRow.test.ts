import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../lib/api/endpoints';
import { ui } from '../../lib/state';
import type { ExternalSession } from '../../lib/api/types';
import ExternalRow from '../ExternalRow.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  ui.toasts = [];
});

const NOW = Date.now();

function row(over: Partial<ExternalSession> = {}): ExternalSession {
  return {
    kind: 'external',
    instanceId: 'inst-1',
    generation: 3,
    pid: 4242,
    sessionId: null,
    title: null,
    cwd: '/home/me/projects/alpha',
    model: { provider: 'openrouter', id: 'z-ai/glm' },
    startedAt: NOW - 120_000,
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

describe('ExternalRow', () => {
  it('falls back to the cwd basename when there is no title', () => {
    render(ExternalRow, { row: row() });
    expect(document.querySelector('.title')?.textContent).toContain('alpha');
    expect(document.querySelector('.sub')?.textContent).toContain('pid 4242');
  });

  it('shows the title when the gateway reports one', () => {
    render(ExternalRow, { row: row({ title: 'Refactor auth', cwd: '/tmp/x' }) });
    expect(document.querySelector('.title')?.textContent).toContain('Refactor auth');
  });

  it('shows the needs input chip and the stale marker', () => {
    render(ExternalRow, { row: row({ inputRequired: true, ask: { requestId: 'r1', since: NOW }, stale: true }) });
    expect(document.querySelector('.chip')?.textContent).toContain('needs input');
    expect(document.querySelector('.stale')).not.toBeNull();
  });

  it('Open in omp.sh calls collabLink once with view and opens the returned url', async () => {
    const link = vi.spyOn(endpoints.sessions, 'collabLink').mockResolvedValue({ url: 'https://omp.sh/cap/one' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(ExternalRow, { row: row() });
    buttonNamed(document.body, 'Session options for alpha')!.click();
    await settle();
    buttonNamed(document.body, 'Open in omp.sh')!.click();
    await settle();
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith('inst-1', 3, 'view');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://omp.sh/cap/one', '_blank', 'noopener,noreferrer');
    expect(document.body.textContent).not.toContain('omp.sh/cap');
  });

  it('tapping the row itself opens the session', async () => {
    const link = vi.spyOn(endpoints.sessions, 'collabLink').mockResolvedValue({ url: 'https://omp.sh/cap/two' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(ExternalRow, { row: row() });
    buttonNamed(document.body, 'alpha (external, pid 4242)')!.click();
    await settle();
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith('inst-1', 3, 'view');
    expect(open).toHaveBeenCalledWith('https://omp.sh/cap/two', '_blank', 'noopener,noreferrer');
  });

  it('shows an error toast when the link call fails', async () => {
    vi.spyOn(endpoints.sessions, 'collabLink').mockRejectedValue(new Error('gone'));
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(ExternalRow, { row: row() });
    buttonNamed(document.body, 'Session options for alpha')!.click();
    await settle();
    buttonNamed(document.body, 'Open in omp.sh')!.click();
    await settle();
    expect(ui.toasts.some((t) => t.text === 'Could not open the session')).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('Copy path writes the cwd to the clipboard', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    render(ExternalRow, { row: row() });
    buttonNamed(document.body, 'Session options for alpha')!.click();
    await settle();
    buttonNamed(document.body, 'Copy path')!.click();
    await settle();
    expect(write).toHaveBeenCalledWith('/home/me/projects/alpha');
  });
});
