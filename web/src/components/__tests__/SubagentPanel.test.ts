import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessions as api } from '../../lib/api/endpoints';
import type { OmpEvent, SubagentMessagesResponse, SubagentProgressFrame } from '../../lib/api/types';
import { active, subagents } from '../../lib/state';
import { emptyTranscript } from '../../lib/transcript/reducer';
import PlanPanel from '../PlanPanel.svelte';
import SubagentPanel from '../SubagentPanel.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

function feedProgress(payload: SubagentProgressFrame): void {
  const ev: OmpEvent = { type: 'subagent_progress', payload };
  subagents.feed(ev);
}

afterEach(() => {
  cleanup();
  subagents.clear();
  active.gwId = null;
  active.transcript = emptyTranscript();
  vi.restoreAllMocks();
});

describe('SubagentPanel', () => {
  it('renders an empty state while no subagent has been seen', () => {
    const { target } = render(SubagentPanel, {});
    expect(target.textContent).toContain('No helpers in this session.');
    expect(target.querySelector('button')).toBeNull();
  });

  it('renders rows with status glyphs, current tool, tokens, cost and retry badge', () => {
    feedProgress({ index: 1, agent: 'explore', task: 'map the tool surface', progress: {
      id: 'a1', index: 1, agent: 'explore', status: 'running', task: 'map the tool surface',
      currentTool: 'bash', tokens: 1200, cost: 0.03, resolvedModel: 'claude-sonnet',
      retryState: { attempt: 2, maxAttempts: 3 },
    } });
    feedProgress({ index: 2, agent: 'fix', assignment: 'patch the parser', progress: {
      id: 'a2', index: 2, agent: 'fix', status: 'completed', assignment: 'patch the parser', tokens: 30,
    } });
    feedProgress({ index: 3, agent: 'break', progress: { id: 'a3', index: 3, agent: 'break', status: 'failed' } });
    const { target } = render(SubagentPanel, {});
    const rows = [...target.querySelectorAll('li')];
    expect(rows.map((r) => r.className.includes('st-'))).toEqual([true, true, true]);
    expect(rows[0]!.classList.contains('st-running')).toBe(true);
    expect(rows[1]!.classList.contains('st-completed')).toBe(true);
    expect(rows[2]!.classList.contains('st-failed')).toBe(true);
    const running = rows[0]!;
    expect(running.textContent).toContain('explore');
    expect(running.textContent).toContain('bash');
    expect(running.textContent).toContain('attempt 2/3');
    expect(running.textContent).toContain('1.2k tok');
    expect(running.textContent).toContain('$0.03');
    expect(running.textContent).toContain('claude-sonnet');
    expect(running.querySelector('.spinner')).not.toBeNull();
    expect(rows[1]!.querySelector('.spinner')).toBeNull();
    // The status word is only spoken, not shown: it lives in the row's aria-label.
    expect(rows[2]!.querySelector('button')!.getAttribute('aria-label')).toContain('Failed');
    // Row descriptions truncate with the full text as the title.
    const desc = rows[0]!.querySelector('.desc')!;
    expect(desc.getAttribute('title')).toBe('map the tool surface');
  });

  it('falls back through description, task and assignment for the row text', () => {
    feedProgress({ index: 1, agent: 'a', task: 'the task', progress: { id: 'f1', index: 1, status: 'running' } });
    feedProgress({ index: 2, agent: 'b', assignment: 'the assignment', progress: { id: 'f2', index: 2, status: 'running' } });
    const { target } = render(SubagentPanel, {});
    const rows = [...target.querySelectorAll('.desc')];
    expect(rows[0]!.textContent).toContain('the task');
    expect(rows[1]!.textContent).toContain('the assignment');
  });

  it('opens the transcript sheet from a row and fetches messages', async () => {
    active.gwId = 'g1';
    const messages = vi.spyOn(api.subagents, 'messages').mockResolvedValueOnce({
      messages: [
        { role: 'user', content: 'find the bug' },
        { role: 'assistant', content: [{ type: 'text', text: 'the bug is in reduce()' }] },
      ],
      nextByte: 2048,
      reset: false,
      sessionFile: 'sub.jsonl',
    } satisfies SubagentMessagesResponse);
    feedProgress({ index: 1, agent: 'explore', progress: { id: 'a1', index: 1, agent: 'explore', status: 'completed' } });
    const { target } = render(SubagentPanel, {});
    target.querySelector<HTMLButtonElement>('li button.row')!.click();
    await settle();
    expect(messages).toHaveBeenCalledWith('g1', 'a1', undefined);
    const text = target.textContent!;
    expect(text).toContain('find the bug');
    expect(text).toContain('the bug is in reduce()');
    expect(target.querySelector('dialog')).not.toBeNull();
    expect(buttonNamed(target, 'Load more')).toBeDefined();
  });

  it('loads more pages via nextByte and hides the button when the stream ends', async () => {
    active.gwId = 'g1';
    const messages = vi.spyOn(api.subagents, 'messages')
      .mockResolvedValueOnce({ messages: [{ role: 'user', content: 'page one' }], nextByte: 512, reset: false, sessionFile: null })
      .mockResolvedValueOnce({ messages: [{ role: 'assistant', content: 'page two' }], nextByte: null, reset: false, sessionFile: null });
    feedProgress({ index: 1, agent: 'explore', progress: { id: 'a1', index: 1, agent: 'explore', status: 'running' } });
    const { target } = render(SubagentPanel, {});
    target.querySelector<HTMLButtonElement>('li button.row')!.click();
    await settle();
    buttonNamed(target, 'Load more')!.click();
    await settle();
    expect(messages).toHaveBeenNthCalledWith(2, 'g1', 'a1', 512);
    expect(target.textContent).toContain('page one');
    expect(target.textContent).toContain('page two');
    expect(buttonNamed(target, 'Load more')).toBeUndefined();
  });

  it('terminates load-more when nextByte repeats without advancing', async () => {
    active.gwId = 'g1';
    vi.spyOn(api.subagents, 'messages')
      .mockResolvedValueOnce({ messages: [{ role: 'user', content: 'page one' }], nextByte: 512, reset: false, sessionFile: null })
      .mockResolvedValueOnce({ messages: [], nextByte: 512, reset: false, sessionFile: null });
    feedProgress({ index: 1, agent: 'explore', progress: { id: 'a1', index: 1, agent: 'explore', status: 'running' } });
    const { target } = render(SubagentPanel, {});
    target.querySelector<HTMLButtonElement>('li button.row')!.click();
    await settle();
    expect(buttonNamed(target, 'Load more')).toBeDefined();
    buttonNamed(target, 'Load more')!.click();
    await settle();
    expect(buttonNamed(target, 'Load more')).toBeUndefined();
  });

  it('replaces transcript messages when reset is true', async () => {
    active.gwId = 'g1';
    vi.spyOn(api.subagents, 'messages')
      .mockResolvedValueOnce({ messages: [{ role: 'user', content: 'stale message' }], nextByte: 256, reset: false, sessionFile: null })
      .mockResolvedValueOnce({ messages: [{ role: 'assistant', content: 'fresh after reset' }], nextByte: 512, reset: true, sessionFile: null });
    feedProgress({ index: 1, agent: 'explore', progress: { id: 'a1', index: 1, agent: 'explore', status: 'running' } });
    const { target } = render(SubagentPanel, {});
    target.querySelector<HTMLButtonElement>('li button.row')!.click();
    await settle();
    expect(target.textContent).toContain('stale message');
    buttonNamed(target, 'Load more')!.click();
    await settle();
    expect(target.textContent).not.toContain('stale message');
    expect(target.textContent).toContain('fresh after reset');
  });

  it('shows waiting state when opening a row without an id', async () => {
    active.gwId = 'g1';
    const messages = vi.spyOn(api.subagents, 'messages');
    feedProgress({ index: 1, agent: 'early', progress: { index: 1, status: 'running' } });
    const { target } = render(SubagentPanel, {});
    target.querySelector<HTMLButtonElement>('li button.row')!.click();
    await settle();
    expect(messages).not.toHaveBeenCalled();
    expect(target.textContent).toContain('Waiting for the helper to start.');
  });

  it('shows the fetch error in the sheet instead of a crash', async () => {
    active.gwId = 'g1';
    vi.spyOn(api.subagents, 'messages').mockRejectedValueOnce(new Error('subagent gone'));
    feedProgress({ index: 1, agent: 'explore', progress: { id: 'a1', index: 1, agent: 'explore', status: 'completed' } });
    const { target } = render(SubagentPanel, {});
    target.querySelector<HTMLButtonElement>('li button.row')!.click();
    await settle();
    expect(target.querySelector('dialog')!.textContent).toContain('subagent gone');
  });

  it('adds the Helpers tab to the panel with the roster count, disabled while empty', async () => {
    const { target } = render(PlanPanel, {});
    const tab = buttonNamed(target, /Helpers/)!;
    expect(tab.disabled).toBe(true);
    expect(target.textContent).not.toContain('explore');

    feedProgress({ index: 1, agent: 'explore', progress: { id: 'a1', index: 1, agent: 'explore', status: 'running' } });
    await settle();
    expect(tab.disabled).toBe(false);
    expect(tab.textContent?.replace(/\s+/g, ' ')).toContain('Helpers 1');
    buttonNamed(target, /Helpers/)?.click();
    await settle();
    expect(target.querySelector('#plan-pane-agents')!.textContent).toContain('explore');
  });
});
