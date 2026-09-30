import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { active, ui } from '../../lib/state';
import { emptyTranscript, lastTurnFailure } from '../../lib/transcript/reducer';
import type { Item } from '../../lib/transcript/types';
import Composer from '../Composer.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

function setStreaming(on: boolean) {
  active.transcript = { ...emptyTranscript(), running: on };
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
  active.phase = 'ready';
  active.info = null;
  active.queued = 0;
  active.commands = [];
  active.transcript = emptyTranscript();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  active.phase = 'idle';
});

function type(target: HTMLElement, value: string) {
  const ta = target.querySelector('textarea')!;
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return ta;
}

describe('Composer send modes', () => {
  it('idle: one Send button, Enter sends a prompt', async () => {
    const send = vi.spyOn(active, 'send').mockResolvedValue(true);
    const { target } = render(Composer, { gwId: 'g1' });
    expect(buttonNamed(target, 'Send')).toBeDefined();
    expect(buttonNamed(target, 'Steer')).toBeUndefined();
    expect(buttonNamed(target, 'Stop')).toBeUndefined();
    const ta = type(target, 'hello');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(send).toHaveBeenCalledWith('hello', 'prompt', undefined);
    expect(ta.value).toBe('');
  });

  it('streaming: Steer is primary, Queue and Stop appear', async () => {
    setStreaming(true);
    const send = vi.spyOn(active, 'send').mockResolvedValue(true);
    const { target } = render(Composer, { gwId: 'g1' });
    expect(buttonNamed(target, 'Stop')).toBeDefined();
    expect(buttonNamed(target, 'Queue')).toBeDefined();
    type(target, 'change course');
    buttonNamed(target, 'Steer')!.click();
    await settle();
    expect(send).toHaveBeenLastCalledWith('change course', 'steer', undefined);
    type(target, 'later');
    buttonNamed(target, 'Queue')!.click();
    await settle();
    expect(send).toHaveBeenLastCalledWith('later', 'follow_up', undefined);
  });

  it('streaming: Enter steers and Ctrl+Enter queues', async () => {
    setStreaming(true);
    const send = vi.spyOn(active, 'send').mockResolvedValue(true);
    const { target } = render(Composer, { gwId: 'g1' });
    const ta = type(target, 'one');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(send).toHaveBeenLastCalledWith('one', 'steer', undefined);
    type(target, 'two');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(send).toHaveBeenLastCalledWith('two', 'follow_up', undefined);
  });

  it('a failed send puts the words back', async () => {
    vi.spyOn(active, 'send').mockResolvedValue(false);
    const { target } = render(Composer, { gwId: 'g1' });
    const ta = type(target, 'keep me');
    buttonNamed(target, 'Send')!.click();
    await settle();
    expect(ta.value).toBe('keep me');
  });

  it('shows the queued count', () => {
    active.queued = 2;
    const { target } = render(Composer, { gwId: 'g1' });
    expect(target.textContent).toContain('2 queued');
  });

  it('a slash command with no argument sends on Enter', async () => {
    active.commands = [{ name: 'compact', description: 'Compact context', source: 'builtin' }];
    const send = vi.spyOn(active, 'send').mockResolvedValue(true);
    const { target } = render(Composer, { gwId: 'g1' });
    const ta = type(target, '/comp');
    expect(target.querySelector('[role="listbox"]')).not.toBeNull();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(send).toHaveBeenCalledWith('/compact', 'prompt', undefined);
  });

  it('drafts are per session', async () => {
    const a = render(Composer, { gwId: 'a' });
    type(a.target, 'draft for a');
    cleanup();
    const b = render(Composer, { gwId: 'b' });
    expect(b.target.querySelector('textarea')!.value).toBe('');
    cleanup();
    const again = render(Composer, { gwId: 'a' });
    expect(again.target.querySelector('textarea')!.value).toBe('draft for a');
  });
});

describe('Composer bar layout', () => {
  it('keeps the send controls out of the scrolling chips row', () => {
    const { target } = render(Composer, { gwId: 'g1' });
    const bar = target.querySelector('.bar')!;
    const scroller = bar.querySelector('.chips-scroll')!;
    const right = bar.querySelector('.right')!;
    expect(scroller.contains(right)).toBe(false);
    expect(right.contains(buttonNamed(target, 'Send')!)).toBe(true);
    expect(scroller.contains(buttonNamed(target, 'Send')!)).toBe(false);
    expect(bar.children).toHaveLength(4);
  });
});

describe('Composer retry chip', () => {
  /** A backend turn failure: omp saw the prompt, so the chip may offer a retry. */
  function failLastTurn(error = 'boom') {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: 'do it', images: 0, pending: false },
      { kind: 'assistant', id: 'a1', text: '', streaming: false, error },
    ];
    active.transcript = { ...emptyTranscript(), items };
    flushSync();
  }

  afterEach(() => {
    for (const t of [...ui.toasts]) ui.dismissToast(t.id);
  });

  it('is hidden on a clean session', () => {
    const { target } = render(Composer, { gwId: 'g1' });
    expect(buttonNamed(target, 'Retry')).toBeUndefined();
  });

  it('is hidden once a healthy turn follows the failed one', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: 'do it', images: 0, pending: false },
      { kind: 'assistant', id: 'a1', text: '', streaming: false, error: 'boom' },
      { kind: 'user', id: 'u2', text: 'again', images: 0, pending: false },
      { kind: 'assistant', id: 'a2', text: 'ok', streaming: false },
    ];
    active.transcript = { ...emptyTranscript(), items };
    flushSync();
    const { target } = render(Composer, { gwId: 'g1' });
    expect(buttonNamed(target, 'Retry')).toBeUndefined();
  });

  it('is hidden when the session is not ready or gone', () => {
    failLastTurn();
    for (const phase of ['loading', 'gone', 'error'] as const) {
      active.phase = phase;
      const { target } = render(Composer, { gwId: 'g1' });
      expect(buttonNamed(target, 'Retry')).toBeUndefined();
      cleanup();
    }
  });

  it('appears after a failed turn, never while streaming', () => {
    failLastTurn();
    const { target } = render(Composer, { gwId: 'g1' });
    expect(buttonNamed(target, 'Retry')).toBeDefined();
    active.transcript = { ...active.transcript, running: true };
    flushSync();
    expect(buttonNamed(target, 'Retry')).toBeUndefined();
    expect(buttonNamed(target, 'Stop')).toBeDefined();
  });

  it('click calls retry once, hides the chip and keeps the failed history', async () => {
    failLastTurn('omp exploded');
    const retry = vi.spyOn(active, 'retry').mockResolvedValue({});
    const { target } = render(Composer, { gwId: 'g1' });
    buttonNamed(target, 'Retry')!.click();
    await settle();
    expect(retry).toHaveBeenCalledOnce();
    expect(active.transcript.retried).toBe(true);
    expect(buttonNamed(target, 'Retry')).toBeUndefined();
    // History is not rewritten: the errored assistant stays until omp's events replace the turn.
    const a1 = active.transcript.items.find((i) => i.id === 'a1');
    expect(a1 && a1.kind === 'assistant' && a1.error === 'omp exploded').toBe(true);
  });

  it('a double click does not fire a second retry', async () => {
    failLastTurn();
    const retry = vi.spyOn(active, 'retry').mockResolvedValue({});
    const { target } = render(Composer, { gwId: 'g1' });
    const btn = buttonNamed(target, 'Retry')!;
    btn.click();
    btn.click();
    await settle();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('a 4xx shows a toast and keeps the failed state', async () => {
    failLastTurn('omp refused');
    vi.spyOn(active, 'retry').mockRejectedValue(new Error('omp refused'));
    const { target } = render(Composer, { gwId: 'g1' });
    buttonNamed(target, 'Retry')!.click();
    await settle();
    expect(ui.toasts.some((t) => t.kind === 'error' && t.text === 'omp refused')).toBe(true);
    expect(lastTurnFailure(active.transcript)).toBe('omp refused');
    expect(buttonNamed(target, 'Retry')).toBeDefined();
  });
});
