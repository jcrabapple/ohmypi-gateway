import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { FileIndexEntry } from '../../lib/api/types';
import { active } from '../../lib/state';
import { viewport } from '../../lib/ui/media.svelte';
import { emptyTranscript } from '../../lib/transcript/reducer';
import Composer from '../Composer.svelte';
import { cleanup, render, settle } from './mount';

const ENTRIES: FileIndexEntry[] = [
  { name: 'src', path: 'src', isDir: true, size: null },
  { name: 'readme.md', path: 'readme.md', isDir: false, size: 120 },
  { name: 'notes.txt', path: 'notes.txt', isDir: false, size: 9 },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

/** Set the textarea value with the caret at the end, like a real keystroke. */
function type(target: HTMLElement, value: string): HTMLTextAreaElement {
  const ta = target.querySelector('textarea')!;
  ta.value = value;
  ta.setSelectionRange(value.length, value.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return ta;
}

function options(target: HTMLElement): HTMLElement[] {
  return [...target.querySelectorAll('[role="option"]')] as HTMLElement[];
}

describe('Composer @-file mentions', () => {
  it('debounces the listing per directory and serves repeats from cache', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { entries: ENTRIES }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-at' });
      type(target, 'see @s');
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(fetchMock).toHaveBeenCalledOnce();
      // Assert the raw string: happy-dom's URL parser decodes %2F in queries.
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('/api/sessions/g-at/files?prefix=');

      // Refining within the same directory re-ranks what it already has.
      type(target, 'see @re');
      await vi.advanceTimersByTimeAsync(150);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(options(target).map((o) => o.getAttribute('aria-label'))).toEqual(['readme.md']);

      // A new directory fetches once, then the cache answers repeats.
      // atDirPrefix('src/') is 'src'; the gateway normalizes both forms.
      type(target, 'see @src/');
      await vi.advanceTimersByTimeAsync(150);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toMatch(/files\?prefix=src$/);
      type(target, 'see @src/r');
      await vi.advanceTimersByTimeAsync(150);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never applies a stale response for an old directory', async () => {
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => pending.push(res))));
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-stale' });
      type(target, 'a @s');
      await vi.advanceTimersByTimeAsync(150);
      type(target, 'a @src/');
      await vi.advanceTimersByTimeAsync(150);
      expect(pending.length).toBe(2);
      pending[0]!(jsonResponse(200, { entries: [{ name: 'stale.txt', path: 'stale.txt', isDir: false, size: 1 }] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(options(target).map((o) => o.getAttribute('aria-label'))).not.toContain('stale.txt');
      pending[1]!(jsonResponse(200, { entries: [{ name: 'fresh.txt', path: 'src/fresh.txt', isDir: false, size: 1 }] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(options(target).map((o) => o.getAttribute('aria-label'))).toEqual(['src/fresh.txt']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused listing is a quiet note, not a crash', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403, { error: 'path escapes the session directory' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-403' });
      const ta = type(target, 'look @s');
      await vi.advanceTimersByTimeAsync(150);
      expect(options(target)).toEqual([]);
      const note = target.querySelector('[role="status"]');
      expect(note?.textContent).toContain('unavailable');
      // The composer keeps working; a later directory is fetched normally.
      type(target, 'look @src/');
      await vi.advanceTimersByTimeAsync(150);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ta.value).toBe('look @src/');
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes listbox semantics and moves the active option with arrows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: ENTRIES })));
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-a11y' });
      const ta = type(target, 'look @s');
      await vi.advanceTimersByTimeAsync(150);
      expect(ta.getAttribute('role')).toBe('combobox');
      expect(ta.getAttribute('aria-expanded')).toBe('true');
      expect(ta.getAttribute('aria-controls')).toMatch(/-at$/);
      const list = target.querySelector('[role="listbox"]')!;
      expect(options(target).length).toBe(2); // src (prefix) + notes.txt (subsequence)
      const first = ta.getAttribute('aria-activedescendant')!;
      expect(list.querySelector(`#${CSS.escape(first)}`)?.getAttribute('aria-selected')).toBe('true');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      flushSync();
      const second = ta.getAttribute('aria-activedescendant')!;
      expect(second).not.toBe(first);
      expect(list.querySelector(`#${CSS.escape(second)}`)?.getAttribute('aria-selected')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('click replaces the whole token with a single separator space and closes the list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: ENTRIES })));
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-click' });
      const ta = type(target, 'look @s and then');
      await vi.advanceTimersByTimeAsync(150);
      ta.setSelectionRange(7, 7); // caret still inside the @query, before " and then"
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      await vi.advanceTimersByTimeAsync(150);
      options(target)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(ta.value).toBe('look @src and then');
      expect(target.querySelector('[role="listbox"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Enter inserts the active option and does not send', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: ENTRIES })));
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-enter' });
      const ta = type(target, 'x @re');
      await vi.advanceTimersByTimeAsync(150);
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(ta.value).toBe('x @readme.md');
      expect(active.transcript.items).toHaveLength(0);
      expect(target.querySelector('[role="listbox"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape with zero matches is swallowed and dismisses the open at state', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-esc-empty' });
      const ta = type(target, 'see @zzz');
      await vi.advanceTimersByTimeAsync(150);
      // Open at state, nothing rendered: no rows, no note, no listbox, no combobox.
      expect(options(target)).toEqual([]);
      expect(target.querySelector('[role="listbox"]')).toBeNull();
      expect(ta.getAttribute('role')).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
      let bubbled = false;
      const spy = () => (bubbled = true);
      document.addEventListener('keydown', spy);
      try {
        const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        ta.dispatchEvent(e);
        flushSync();
        expect(e.defaultPrevented).toBe(true);
        expect(bubbled).toBe(false);
      } finally {
        document.removeEventListener('keydown', spy);
      }
      // The dismissal was reset by the edit: a token in a NEW directory
      // re-opens the popover and fetches (same-dir repeats are cache hits).
      type(target, 'see @zzz/x');
      await vi.advanceTimersByTimeAsync(150);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toMatch(/files\?prefix=zzz$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retyping the same draft text after Escape re-opens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: ENTRIES })));
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-esc-retype' });
      const ta = type(target, 'x @s');
      await vi.advanceTimersByTimeAsync(150);
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      flushSync();
      expect(target.querySelector('[role="listbox"]')).toBeNull();
      type(target, 'x @s'); // identical text, but the token was rebuilt
      await vi.advanceTimersByTimeAsync(150);
      expect(target.querySelector('[role="listbox"]')).not.toBeNull();
      expect(ta.value).toBe('x @s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('mobile sheet lists plain button rows, drills folders, and keeps Escape to itself', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: ENTRIES })));
    vi.useFakeTimers();
    viewport.narrow = true;
    try {
      const { target } = render(Composer, { gwId: 'g-sheet' });
      const ta = type(target, 'see @s');
      await vi.advanceTimersByTimeAsync(150);
      // No listbox claims in sheet mode: plain buttons in a plain list.
      expect(target.querySelector('[role="listbox"]')).toBeNull();
      expect(ta.getAttribute('role')).toBeNull();
      const rows = [...target.querySelectorAll('.at-sheet .at-row')] as HTMLButtonElement[];
      expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['src', 'notes.txt']);
      // A folder row drills down instead of inserting.
      rows[0]!.click();
      await settle();
      await vi.advanceTimersByTimeAsync(150);
      expect(target.querySelector('.at-sheet .at-back')).not.toBeNull();
      // Escape on the sheet body is consumed and closes the sheet, not an overlay.
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      target.querySelector('.at-sheet')!.dispatchEvent(e);
      await settle();
      expect(e.defaultPrevented).toBe(true);
      expect(target.querySelector('.at-sheet')).toBeNull();
      // Re-open and pick a file row: it lands in the draft and closes the sheet.
      type(target, 'see @s');
      await vi.advanceTimersByTimeAsync(150);
      const filed = [...target.querySelectorAll('.at-sheet .at-row')] as HTMLButtonElement[];
      filed.find((r) => r.getAttribute('aria-label') === 'notes.txt')!.click();
      await settle();
      expect(ta.value).toBe('see @notes.txt');
      expect(target.querySelector('.at-sheet')).toBeNull();
    } finally {
      viewport.narrow = false;
      vi.useRealTimers();
    }
  });

  it('Escape dismisses; typing again re-opens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: ENTRIES })));
    vi.useFakeTimers();
    try {
      const { target } = render(Composer, { gwId: 'g-esc' });
      const ta = type(target, 'x @s');
      await vi.advanceTimersByTimeAsync(150);
      expect(options(target).length).toBeGreaterThan(0);
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      flushSync();
      expect(target.querySelector('[role="listbox"]')).toBeNull();
      expect(ta.value).toBe('x @s');
      type(target, 'x @sr');
      await vi.advanceTimersByTimeAsync(150);
      expect(target.querySelector('[role="listbox"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
