// ANSI SGR to safe HTML. Supported: reset, bold, dim, italic, underline, the 16
// basic foreground colors (classes, themed through --ansi-N), 256 and truecolor
// foregrounds (inline color built from clamped integers). Every other escape
// sequence and control character is dropped.
import { escapeHtml } from './escape';

// CSI (params, intermediates, final byte), OSC (up to BEL or ST), other two-byte escapes.
const ESCAPES = /\x1b(?:\[([ -?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** 0-15 for the themed palette, or a `#rrggbb` string. */
  fg: number | string | null;
}

const fresh = (): Style => ({ bold: false, dim: false, italic: false, underline: false, fg: null });

const CUBE = [0, 95, 135, 175, 215, 255];
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const clamp = (n: number) => Math.max(0, Math.min(255, Math.trunc(n) || 0));
const rgb = (r: number, g: number, b: number) => `#${hex2(clamp(r))}${hex2(clamp(g))}${hex2(clamp(b))}`;

function color256(n: number): number | string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return n;
  if (n < 232) {
    const i = n - 16;
    return rgb(CUBE[Math.floor(i / 36)]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!);
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

function applySgr(style: Style, raw: string): void {
  const p = raw === '' ? [0] : raw.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === 0) Object.assign(style, fresh());
    else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 22) { style.bold = false; style.dim = false; }
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c >= 30 && c <= 37) style.fg = c - 30;
    else if (c === 39) style.fg = null;
    else if (c >= 90 && c <= 97) style.fg = c - 90 + 8;
    else if (c === 38 || c === 48) {
      const mode = p[i + 1];
      if (mode === 5) {
        if (c === 38) style.fg = color256(p[i + 2]!) ?? style.fg;
        i += 2;
      } else if (mode === 2) {
        if (c === 38) style.fg = rgb(p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0);
        i += 4;
      }
    }
  }
}

function open(style: Style): string {
  const cls: string[] = [];
  if (style.bold) cls.push('ansi-b');
  if (style.dim) cls.push('ansi-d');
  if (style.italic) cls.push('ansi-i');
  if (style.underline) cls.push('ansi-u');
  let inline = '';
  if (typeof style.fg === 'number') cls.push(`ansi-fg-${style.fg}`);
  else if (typeof style.fg === 'string') inline = ` style="color:${style.fg}"`;
  if (!cls.length && !inline) return '';
  return `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${inline}>`;
}

function plain(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(CONTROL, '');
}

export function ansiToHtml(input: string): string {
  const style = fresh();
  let out = '';
  let last = 0;

  const emit = (text: string) => {
    const t = plain(text);
    if (!t) return;
    const tag = open(style);
    out += tag ? `${tag}${escapeHtml(t)}</span>` : escapeHtml(t);
  };

  for (const m of input.matchAll(ESCAPES)) {
    emit(input.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === 'm') applySgr(style, m[1] ?? '');
  }
  emit(input.slice(last));
  return out;
}

export function stripAnsi(input: string): string {
  return plain(input.replace(ESCAPES, ''));
}
