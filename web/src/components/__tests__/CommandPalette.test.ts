import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session, saved } from '../../lib/palette/__tests__/factories';
import { nav, sessionsStore, ui } from '../../lib/state';
import CommandPalette from '../CommandPalette.svelte';
import { cleanup, render, settle } from './mount';

beforeEach(() => {
  sessionsStore.live = [session('one', { ompSessionName: 'Fix the parser' }), session('two', { ompSessionName: 'Write docs', pendingUi: [{ id: 'r', method: 'confirm', title: 'x' }] })];
  sessionsStore.saved = [saved('/h/a.jsonl', 'Old refactor work')];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionsStore.live = [];
  sessionsStore.saved = [];
  while (ui.overlays.length) ui.close();
});

function mountPalette() {
  const onclose = vi.fn();
  const r = render(CommandPalette, { onclose });
  const input = r.target.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = async (v: string) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  };
  const key = async (k: string, init: KeyboardEventInit = {}) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
    await settle();
  };
  const titles = () => [...r.target.querySelectorAll('[role="option"] .title')].map((e) => e.textContent);
  return { ...r, onclose, input, type, key, titles };
}

describe('CommandPalette', () => {
  it('opens on actions and live sessions, with headings, and the waiting session first', async () => {
    const p = mountPalette();
    await settle();
    const t = p.titles();
    expect(t[0]).toBe('New session');
    expect(t).toContain('Write docs');
    expect(t.indexOf('Write docs')).toBeLessThan(t.indexOf('Fix the parser'));
    expect(p.target.querySelectorAll('.head').length).toBeGreaterThan(1);
    expect(p.input.getAttribute('aria-expanded')).toBe('true');
  });

  it('filters as you type and drops the headings', async () => {
    const p = mountPalette();
    await p.type('parser');
    expect(p.titles()).toEqual(['Fix the parser']);
    expect(p.target.querySelectorAll('.head')).toHaveLength(0);
  });

  it('finds history and settings pages', async () => {
    const p = mountPalette();
    await p.type('refactor');
    expect(p.titles()).toContain('Old refactor work');
    await p.type('appearance');
    expect(p.titles()).toContain('Appearance');
  });

  it('shows an empty state with a hint when nothing matches', async () => {
    const p = mountPalette();
    await p.type('zzzzqqq');
    expect(p.titles()).toEqual([]);
    expect(p.target.querySelector('.empty')?.textContent).toContain('Nothing matches "zzzzqqq"');
  });

  it('arrows move the selection, wrap, and update aria-activedescendant', async () => {
    const p = mountPalette();
    await settle();
    const opts = () => [...p.target.querySelectorAll('[role="option"]')];
    expect(opts()[0]!.getAttribute('aria-selected')).toBe('true');
    await p.key('ArrowDown');
    expect(opts()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(p.input.getAttribute('aria-activedescendant')).toBe(opts()[1]!.id);
    await p.key('ArrowUp');
    await p.key('ArrowUp');
    expect(opts().at(-1)!.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter closes the palette and then opens the chosen session', async () => {
    const open = vi.spyOn(nav, 'open').mockImplementation(() => {});
    const p = mountPalette();
    await p.type('parser');
    await p.key('Enter');
    expect(p.onclose).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('one');
  });

  it('clicking a row chooses it', async () => {
    const resume = vi.spyOn(nav, 'resume').mockResolvedValue(undefined as never);
    const p = mountPalette();
    await p.type('refactor');
    p.target.querySelector<HTMLElement>('[role="option"]')!.click();
    await Promise.resolve();
    expect(resume).toHaveBeenCalled();
  });

  it('Enter with no results does nothing', async () => {
    const p = mountPalette();
    await p.type('zzzzqqq');
    await p.key('Enter');
    expect(p.onclose).not.toHaveBeenCalled();
  });

  it('announces the result count', async () => {
    const p = mountPalette();
    await p.type('parser');
    expect(p.target.querySelector('[role="status"]')?.textContent).toBe('1 result');
  });
});
