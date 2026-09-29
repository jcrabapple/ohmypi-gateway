import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessions as api } from '../../lib/api/endpoints';
import { session } from '../../lib/palette/__tests__/factories';
import { active } from '../../lib/state';
import SessionInfoSheet from '../SessionInfoSheet.svelte';
import { cleanup, render, settle } from './mount';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  active.info = null;
  active.stats = null;
});

describe('SessionInfoSheet', () => {
  it('says so when no session is open', () => {
    const { target } = render(SessionInfoSheet, { onclose: () => {} });
    expect(target.textContent).toContain('No session is open');
  });

  it('shows where the open session runs and its model', async () => {
    vi.spyOn(active, 'refreshInfo').mockResolvedValue(undefined as never);
    vi.spyOn(active, 'refreshStats').mockResolvedValue(undefined as never);
    active.info = session('g1', {
      cwd: '/work/project-x',
      model: { id: 'm1', name: 'Model One', provider: 'p' } as never,
      ompSessionName: 'Parser fix',
    });
    const { target } = render(SessionInfoSheet, { onclose: () => {} });
    await settle();
    const text = target.textContent!;
    expect(text).toContain('Parser fix');
    expect(text).toContain('/work/project-x');
    expect(text).toContain('Model One');
  });

  it('fetches the queue state for the open session', async () => {
    vi.spyOn(active, 'refreshInfo').mockResolvedValue(undefined as never);
    vi.spyOn(active, 'refreshStats').mockResolvedValue(undefined as never);
    vi.spyOn(active, 'gwId', 'get').mockReturnValue('g1');
    const state = vi.spyOn(api, 'state').mockResolvedValue({ data: { queuedMessageCount: 2, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', interruptMode: 'immediate' } } as never);
    active.info = session('g1');
    render(SessionInfoSheet, { onclose: () => {} });
    await settle();
    expect(state).toHaveBeenCalledWith('g1');
  });
});
