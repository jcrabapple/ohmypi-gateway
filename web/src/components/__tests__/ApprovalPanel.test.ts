import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { ApiError } from '../../lib/api/client';
import type { UiRequest } from '../../lib/api/types';
import { active } from '../../lib/state';
import { ui } from '../../lib/state/ui.svelte';
import ApprovalPanel from '../ApprovalPanel.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

afterEach(() => {
  cleanup();
  ui.toasts = [];
});

function req(over: Partial<UiRequest>): UiRequest {
  return { id: 'r1', method: 'select', title: 'Run command\nrm -rf build', options: ['Allow', 'Deny'], ...over };
}

function spyAnswer(impl: () => Promise<unknown> = () => Promise.resolve({})) {
  const answer = vi.spyOn(active, 'answerUi').mockImplementation(impl);
  const drop = vi.spyOn(active, 'dropUi').mockImplementation(() => {});
  return { answer, drop };
}

describe('ApprovalPanel', () => {
  it('splits the title into a headline and a mono detail block', () => {
    const { target } = render(ApprovalPanel, { request: req({ message: 'Because tests' }) });
    expect(target.querySelector('h2')?.textContent).toBe('Run command');
    expect(target.querySelector('pre.detail')?.textContent).toBe('rm -rf build');
    expect(target.textContent).toContain('Because tests');
    expect(target.querySelector('[aria-live="assertive"]')).not.toBeNull();
  });

  it('shows the position when several requests wait', () => {
    const { target } = render(ApprovalPanel, { request: req({}), index: 1, total: 3 });
    expect(target.textContent).toContain('1 of 3');
  });

  it('select: answers with the option text and shows option descriptions', async () => {
    const { answer, drop } = spyAnswer();
    const { target } = render(ApprovalPanel, {
      request: req({ optionDetails: [{ description: 'Once' }, { description: 'Not now' }] }),
    });
    expect(target.textContent).toContain('Not now');
    buttonNamed(target, /^Allow/)!.click();
    await settle();
    expect(answer).toHaveBeenCalledWith('r1', { value: 'Allow' });
    expect(drop).toHaveBeenCalledWith('r1');
  });

  it('select: digit keys answer only after the short arming delay', async () => {
    vi.useFakeTimers();
    const { answer } = spyAnswer();
    render(ApprovalPanel, { request: req({}) });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    expect(answer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    flushSync();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    vi.useRealTimers();
    await settle();
    expect(answer).toHaveBeenCalledWith('r1', { value: 'Deny' });
  });

  it('confirm: Yes and No send a boolean', async () => {
    const { answer } = spyAnswer();
    const { target } = render(ApprovalPanel, { request: req({ method: 'confirm', options: undefined }) });
    buttonNamed(target, 'Yes')!.click();
    await settle();
    expect(answer).toHaveBeenLastCalledWith('r1', { confirmed: true });
    buttonNamed(target, 'No')!.click();
    await settle();
    expect(answer).toHaveBeenLastCalledWith('r1', { confirmed: false });
  });

  it('input: sends the typed value', async () => {
    const { answer } = spyAnswer();
    const { target } = render(ApprovalPanel, { request: req({ method: 'input', options: undefined, placeholder: 'Name' }) });
    const input = target.querySelector('input')!;
    expect(input.placeholder).toBe('Name');
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(answer).toHaveBeenCalledWith('r1', { value: 'hello' });
  });

  it('editor: starts from prefill and sends the edited text', async () => {
    const { answer } = spyAnswer();
    const { target } = render(ApprovalPanel, {
      request: req({ method: 'editor', options: undefined, prefill: 'draft text' }),
    });
    const area = target.querySelector('textarea')!;
    expect(area.value).toBe('draft text');
    area.value = 'edited';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(answer).toHaveBeenCalledWith('r1', { value: 'edited' });
  });

  it('Dismiss cancels', async () => {
    const { answer } = spyAnswer();
    const { target } = render(ApprovalPanel, { request: req({}) });
    buttonNamed(target, 'Dismiss')!.click();
    await settle();
    expect(answer).toHaveBeenCalledWith('r1', { cancelled: true });
  });

  it('409 drops the dialog without an error toast', async () => {
    const { drop } = spyAnswer(() => Promise.reject(new ApiError(409, 'already answered')));
    const { target } = render(ApprovalPanel, { request: req({}) });
    buttonNamed(target, /^Allow/)!.click();
    await settle();
    expect(drop).toHaveBeenCalledWith('r1');
    expect(ui.toasts).toHaveLength(0);
  });

  it('other failures toast and keep the dialog', async () => {
    const { drop } = spyAnswer(() => Promise.reject(new ApiError(500, 'boom')));
    const { target } = render(ApprovalPanel, { request: req({}) });
    buttonNamed(target, /^Allow/)!.click();
    await settle();
    expect(drop).not.toHaveBeenCalled();
    expect(ui.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'boom' });
    expect(buttonNamed(target, /^Allow/)!.disabled).toBe(false);
  });
});
