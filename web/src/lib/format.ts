// Small display helpers shared by the rail, header and transcript.
import type { SavedSession, SessionInfo } from './api/types';

export function basename(path: string | null | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1) || '/';
}

/** "just now", "5m", "3h", "Yesterday" style stamps kept short for the rail. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m} m ${rest} s` : `${m} m`;
}

export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Price per million tokens as shown in the model picker: "$3 / $15", or "free". */
export function priceLabel(cost: { input: number; output: number } | undefined): string {
  if (!cost || (cost.input === 0 && cost.output === 0)) return 'free';
  const f = (n: number) => (n < 1 ? n.toFixed(2).replace(/0$/, '') : String(Number(n.toFixed(2))));
  return `$${f(cost.input)} / $${f(cost.output)}`;
}

export type ContextLevel = 'ok' | 'warn' | 'err';

/** Amber from 70 %, red from 85 %. */
export function contextLevel(percent: number | null | undefined): ContextLevel {
  if (percent == null || !Number.isFinite(percent)) return 'ok';
  if (percent >= 85) return 'err';
  if (percent >= 70) return 'warn';
  return 'ok';
}

export interface TextPart {
  text: string;
  code: boolean;
}

/** Splits `text` on paired backticks so callers can render the spans as code without touching HTML. */
export function splitInlineCode(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), code: false });
    parts.push({ text: m[1]!, code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: false });
  return parts;
}

/**
 * The one title logic for a live session, used by the rail, the header and the palette:
 * its name, else the first prompt (from the saved transcript with the same file), else the folder.
 */
export function sessionTitle(
  s: Pick<SessionInfo, 'ompSessionName' | 'ompSessionFile' | 'cwd'>,
  saved: readonly Pick<SavedSession, 'file' | 'title'>[] = [],
): string {
  const name = s.ompSessionName?.trim();
  if (name) return name;
  if (s.ompSessionFile) {
    const first = saved.find((x) => x.file === s.ompSessionFile)?.title.trim();
    if (first) return first;
  }
  return basename(s.cwd) || 'Session';
}

/**
 * The gateway reports a saved session's real `cwd` when the transcript has one. Only older transcripts
 * fall back to the mangled folder (`-projects-ohmypi-gateway`): when a live session's cwd mangles to the
 * same suffix we show its real folder name, otherwise the folder as saved.
 */
export function savedFolderLabel(
  saved: Pick<SavedSession, 'cwdFolder'> & { cwd?: string | null },
  liveCwds: readonly string[],
): string {
  if (saved.cwd) return basename(saved.cwd) || saved.cwd;
  const folder = saved.cwdFolder;
  for (const cwd of liveCwds) {
    if (folder && cwd.replaceAll('/', '-').endsWith(folder)) return basename(cwd);
  }
  return folder.replace(/^-+/, '') || 'session';
}

export function savedTitle(saved: Pick<SavedSession, 'title' | 'cwdFolder'> & { cwd?: string | null }, liveCwds: readonly string[]): string {
  return saved.title.trim() || savedFolderLabel(saved, liveCwds);
}

export function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n', 1)[0]!.trim();
}

/** Unique nonempty values, most recent first, for cwd suggestions. */
export function uniqueCwds(live: readonly Pick<SessionInfo, 'cwd'>[]): string[] {
  return [...new Set(live.map((s) => s.cwd).filter(Boolean))];
}

/** "12m", "3h 5m", "2d 4h" for how long something has been up. */
export function uptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60);
  if (m < 1) return `${Math.floor(sec)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
