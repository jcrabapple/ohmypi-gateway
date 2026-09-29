import { describe, expect, it, vi } from 'vitest';
import { createKeyMap, isTypingTarget, keyLabels, parseChord, SHORTCUTS, shortcutText, type KeyLike, type ShortcutId } from '../keymap';

function ev(key: string, over: Partial<KeyLike> = {}, target: EventTarget | null = document.body): KeyLike & { prevented: boolean } {
  const e = {
    key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, target,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
    ...over,
  };
  return e;
}

function setup(opts: { apple?: boolean; modal?: boolean } = {}) {
  const run = vi.fn<(id: ShortcutId) => boolean | void>();
  let t = 1000;
  const map = createKeyMap({ run, apple: opts.apple ?? false, modalOpen: () => opts.modal ?? false, now: () => t });
  return { run, map, tick: (ms: number) => (t += ms) };
}

const input = () => Object.assign(document.createElement('input'), { type: 'text' });
const textarea = () => document.createElement('textarea');

describe('chords', () => {
  it('parses modifiers, keys and sequences', () => {
    expect(parseChord('mod+shift+o')).toEqual({ mod: true, shift: true, alt: false, keys: ['o'] });
    expect(parseChord('g n').keys).toEqual(['g', 'n']);
    expect(parseChord('alt+arrowup')).toMatchObject({ alt: true, keys: ['arrowup'] });
  });

  it('labels key caps for both platforms', () => {
    expect(keyLabels('mod+shift+o', false)).toEqual(['Ctrl', 'Shift', 'O']);
    expect(keyLabels('mod+shift+o', true)).toEqual(['⌘', '⇧', 'O']);
    expect(shortcutText('palette', false)).toBe('Ctrl+K');
    expect(shortcutText('next-attention', false)).toBe('G N');
  });

  it('has unique ids and no two global shortcuts on one chord', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    const globals = SHORTCUTS.filter((s) => s.scope === 'global').map((s) => s.chord);
    expect(new Set(globals).size).toBe(globals.length);
  });
});

describe('isTypingTarget', () => {
  it('is true for text controls and false for buttons and checkboxes', () => {
    expect(isTypingTarget(input())).toBe(true);
    expect(isTypingTarget(textarea())).toBe(true);
    expect(isTypingTarget(Object.assign(document.createElement('input'), { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('dispatch', () => {
  it('runs each global shortcut from a quiet page', () => {
    const cases: [string, Partial<KeyLike>, ShortcutId][] = [
      ['k', { ctrlKey: true }, 'palette'],
      [',', { ctrlKey: true }, 'settings'],
      ['O', { ctrlKey: true, shiftKey: true }, 'new-session'],
      ['[', {}, 'toggle-rail'],
      ['/', {}, 'focus-composer'],
      ['ArrowUp', { altKey: true }, 'prev-session'],
      ['ArrowDown', { altKey: true }, 'next-session'],
      ['Escape', {}, 'close'],
    ];
    for (const [key, mods, id] of cases) {
      const { run, map } = setup();
      const e = ev(key, mods);
      expect(map.handle(e), key).toBe(true);
      expect(run).toHaveBeenCalledWith(id);
      expect(e.prevented).toBe(true);
    }
  });

  it('uses Cmd on Apple and ignores Ctrl there', () => {
    const a = setup({ apple: true });
    expect(a.map.handle(ev('k', { metaKey: true }))).toBe(true);
    expect(a.run).toHaveBeenCalledWith('palette');
    const b = setup({ apple: true });
    expect(b.map.handle(ev('k', { ctrlKey: true }))).toBe(false);
    expect(b.run).not.toHaveBeenCalled();
  });

  it('treats a plain k, or Ctrl+K with extra modifiers, as not a shortcut', () => {
    const { run, map } = setup();
    expect(map.handle(ev('k'))).toBe(false);
    expect(map.handle(ev('k', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([['input', input], ['textarea', textarea]])('stays quiet for plain keys while typing in a %s', (_n, make) => {
    const { run, map } = setup();
    const t = make();
    for (const key of ['[', '/', 'g', 'n']) expect(map.handle(ev(key, {}, t))).toBe(false);
    expect(map.handle(ev('ArrowUp', { altKey: true }, t))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('still fires Escape and Ctrl/Cmd chords while typing', () => {
    const { run, map } = setup();
    const t = textarea();
    expect(map.handle(ev('Escape', {}, t))).toBe(true);
    expect(map.handle(ev('k', { ctrlKey: true }, t))).toBe(true);
    expect(map.handle(ev(',', { ctrlKey: true }, t))).toBe(true);
    expect(map.handle(ev('O', { ctrlKey: true, shiftKey: true }, t))).toBe(true);
    expect(run.mock.calls.map((c) => c[0])).toEqual(['close', 'palette', 'settings', 'new-session']);
  });

  it('keeps plain keys quiet while a modal is open but still allows Escape and Ctrl/Cmd', () => {
    const { run, map } = setup({ modal: true });
    expect(map.handle(ev('['))).toBe(false);
    expect(map.handle(ev('/'))).toBe(false);
    expect(map.handle(ev('Escape'))).toBe(true);
    expect(map.handle(ev('k', { ctrlKey: true }))).toBe(true);
    expect(run.mock.calls.map((c) => c[0])).toEqual(['close', 'palette']);
  });

  it('g then n runs next-attention within the window and not after it', () => {
    const a = setup();
    expect(a.map.handle(ev('g'))).toBe(false);
    a.tick(300);
    expect(a.map.handle(ev('n'))).toBe(true);
    expect(a.run).toHaveBeenCalledWith('next-attention');

    const b = setup();
    b.map.handle(ev('g'));
    b.tick(2000);
    expect(b.map.handle(ev('n'))).toBe(false);
    expect(b.run).not.toHaveBeenCalled();
  });

  it('a stray key between g and n cancels the sequence', () => {
    const { run, map } = setup();
    map.handle(ev('g'));
    map.handle(ev('x'));
    expect(map.handle(ev('n'))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('g typed into an input never starts a sequence', () => {
    const { run, map, tick } = setup();
    const t = input();
    map.handle(ev('g', {}, t));
    tick(100);
    expect(map.handle(ev('n', {}, document.body))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores key repeat except Escape', () => {
    const { run, map } = setup();
    expect(map.handle(ev('k', { ctrlKey: true, repeat: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores keys during IME composition', () => {
    const { run, map } = setup();
    expect(map.handle(ev('Escape', { isComposing: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('leaves the key alone when the runner declines', () => {
    const run = vi.fn(() => false);
    const map = createKeyMap({ run, apple: false });
    const e = ev('[');
    expect(map.handle(e)).toBe(false);
    expect(e.prevented).toBe(false);
  });

  it('lets a slash through when it needs shift (some layouts)', () => {
    const { run, map } = setup();
    expect(map.handle(ev('/', { shiftKey: true }))).toBe(true);
    expect(run).toHaveBeenCalledWith('focus-composer');
  });
});
