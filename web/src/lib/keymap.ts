// The keyboard map. One table drives three things: the global dispatcher (Shell), the
// Shortcuts page in settings, and the hints shown next to palette actions. Nothing else
// hard-codes a global shortcut.

export type ShortcutId =
  | 'palette' | 'settings' | 'new-session' | 'next-attention' | 'toggle-rail'
  | 'close' | 'focus-composer' | 'prev-session' | 'next-session'
  | 'send' | 'newline' | 'follow-up' | 'approval-pick';

export type ShortcutGroup = 'General' | 'Sessions' | 'Composer' | 'Approvals';

export interface ShortcutDef {
  id: ShortcutId;
  /** Lower-case chord. `mod` is Ctrl, or Cmd on Apple. Keys after a space form a sequence (`g n`). */
  chord: string;
  label: string;
  group: ShortcutGroup;
  /** Only `global` shortcuts are dispatched here; the rest are listed for reference. */
  scope: 'global' | 'local';
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'palette', chord: 'mod+k', label: 'Command palette', group: 'General', scope: 'global' },
  { id: 'settings', chord: 'mod+,', label: 'Settings', group: 'General', scope: 'global' },
  { id: 'close', chord: 'escape', label: 'Close the top overlay', group: 'General', scope: 'global' },
  { id: 'toggle-rail', chord: '[', label: 'Show or hide the session list', group: 'General', scope: 'global' },
  { id: 'new-session', chord: 'mod+shift+o', label: 'New session', group: 'Sessions', scope: 'global' },
  { id: 'next-attention', chord: 'g n', label: 'Next session that needs you', group: 'Sessions', scope: 'global' },
  { id: 'prev-session', chord: 'alt+arrowup', label: 'Previous session', group: 'Sessions', scope: 'global' },
  { id: 'next-session', chord: 'alt+arrowdown', label: 'Next session', group: 'Sessions', scope: 'global' },
  { id: 'focus-composer', chord: '/', label: 'Focus the message box', group: 'Composer', scope: 'global' },
  { id: 'send', chord: 'enter', label: 'Send', group: 'Composer', scope: 'local' },
  { id: 'newline', chord: 'shift+enter', label: 'New line', group: 'Composer', scope: 'local' },
  { id: 'follow-up', chord: 'mod+enter', label: 'Queue a follow-up while the agent works', group: 'Composer', scope: 'local' },
  { id: 'approval-pick', chord: '1', label: 'Choose approval option 1, 2, 3 and so on', group: 'Approvals', scope: 'local' },
];

export interface ParsedChord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** One key, or two for a sequence. Lower-case `KeyboardEvent.key` values. */
  keys: string[];
}

export function parseChord(chord: string): ParsedChord {
  const steps = chord.trim().split(/\s+/);
  const parts = steps[0]!.split('+');
  const first = parts.pop()!;
  const mods = new Set(parts);
  return {
    mod: mods.has('mod'),
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    keys: [first, ...steps.slice(1)],
  };
}

const NAMES: Record<string, string> = {
  escape: 'Esc', enter: 'Enter', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
};
const APPLE_NAMES: Record<string, string> = { ...NAMES, arrowup: '↑', arrowdown: '↓', enter: '↩' };

export function isApple(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);
}

/** Key caps for a chord, in press order: `['Ctrl', 'Shift', 'O']`, or `['⌘', '⇧', 'O']` on Apple. */
export function keyLabels(chord: string, apple: boolean = isApple()): string[] {
  const p = parseChord(chord);
  const names = apple ? APPLE_NAMES : NAMES;
  const cap = (k: string) => names[k] ?? (k.length === 1 ? k.toUpperCase() : k);
  const out: string[] = [];
  if (p.mod) out.push(apple ? '⌘' : 'Ctrl');
  if (p.alt) out.push(apple ? '⌥' : 'Alt');
  if (p.shift) out.push(apple ? '⇧' : 'Shift');
  out.push(...p.keys.map(cap));
  return out;
}

export function shortcutFor(id: ShortcutId): ShortcutDef {
  return SHORTCUTS.find((s) => s.id === id)!;
}

/** Text for a title attribute or a palette hint: `Ctrl+K`, `G N`. */
export function shortcutText(id: ShortcutId, apple: boolean = isApple()): string {
  const s = shortcutFor(id);
  const labels = keyLabels(s.chord, apple);
  return s.chord.includes(' ') ? labels.join(' ') : labels.join(apple ? '' : '+');
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

/** True when keystrokes are going into a text control. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type);
  }
  return false;
}

export interface KeyMapOptions {
  /** Run a shortcut. Return false to say nothing happened, so the key keeps its default. */
  run: (id: ShortcutId) => boolean | void;
  /** True while a modal overlay is open: plain keys stay quiet, Escape and Ctrl/Cmd still work. */
  modalOpen?: () => boolean;
  apple?: boolean;
  now?: () => number;
}

const SEQUENCE_MS = 1200;

export function createKeyMap(opts: KeyMapOptions) {
  const apple = opts.apple ?? isApple();
  const now = opts.now ?? Date.now;
  const table = SHORTCUTS.filter((s) => s.scope === 'global').map((s) => ({ def: s, parsed: parseChord(s.chord) }));
  let pending: { key: string; at: number } | null = null;

  function fire(id: ShortcutId, e: KeyLike): boolean {
    if (opts.run(id) === false) return false;
    e.preventDefault();
    return true;
  }

  /** Feed every keydown. Returns true when a shortcut consumed the event. */
  function handle(e: KeyLike): boolean {
    if (e.isComposing) return false;
    const key = e.key.toLowerCase();
    const primary = apple ? e.metaKey : e.ctrlKey;
    const other = apple ? e.ctrlKey : e.metaKey;
    const wasPending = pending && now() - pending.at <= SEQUENCE_MS ? pending.key : null;
    pending = null;

    if (key === 'escape') return fire('close', e);
    if (e.repeat) return false;

    const typing = isTypingTarget(e.target);
    const quiet = typing || (opts.modalOpen?.() ?? false);

    for (const { def, parsed } of table) {
      const [first, second] = parsed.keys;
      if (def.id === 'close') continue;
      if (parsed.mod ? !primary || other : e.ctrlKey || e.metaKey) continue;
      if (parsed.alt !== e.altKey) continue;
      // Shift is part of a chord only when it is listed; symbols like `/` and `[` may need it to type.
      if (parsed.shift !== e.shiftKey && (parsed.mod || key.length > 1 || /[a-z0-9]/.test(key))) continue;

      if (second) {
        if (key === second && wasPending === first) return quiet ? false : fire(def.id, e);
        continue;
      }
      if (key !== first) continue;
      // Ctrl/Cmd chords work anywhere; every other shortcut waits until nothing is being typed.
      if (!parsed.mod && quiet) continue;
      return fire(def.id, e);
    }

    // Start a sequence such as `g n`, but only from a plain, quiet keypress.
    if (!quiet && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (table.some(({ parsed }) => parsed.keys.length > 1 && parsed.keys[0] === key)) {
        pending = { key, at: now() };
      }
    }
    return false;
  }

  return { handle };
}
