import { describe, expect, it } from 'vitest';
import { ansiToHtml, stripAnsi } from '../ansi';

const E = '\x1b[';

describe('ansiToHtml', () => {
  it('passes plain text through, escaped', () => {
    expect(ansiToHtml('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;');
    expect(ansiToHtml('')).toBe('');
  });

  it('renders bold, dim, italic and underline as classes', () => {
    expect(ansiToHtml(`${E}1mB${E}0m`)).toBe('<span class="ansi-b">B</span>');
    expect(ansiToHtml(`${E}2mD${E}22m`)).toBe('<span class="ansi-d">D</span>');
    expect(ansiToHtml(`${E}3mI${E}23m`)).toBe('<span class="ansi-i">I</span>');
    expect(ansiToHtml(`${E}4mU${E}24m`)).toBe('<span class="ansi-u">U</span>');
    expect(ansiToHtml(`${E}1;3;4mall`)).toBe('<span class="ansi-b ansi-i ansi-u">all</span>');
  });

  it('maps 30-37 and 90-97 to the 16 themed colors', () => {
    expect(ansiToHtml(`${E}31mr${E}39m`)).toBe('<span class="ansi-fg-1">r</span>');
    expect(ansiToHtml(`${E}37mw`)).toBe('<span class="ansi-fg-7">w</span>');
    expect(ansiToHtml(`${E}90mg`)).toBe('<span class="ansi-fg-8">g</span>');
    expect(ansiToHtml(`${E}97mb`)).toBe('<span class="ansi-fg-15">b</span>');
  });

  it('39 resets the color but keeps other attributes', () => {
    expect(ansiToHtml(`${E}1;32mA${E}39mB${E}0mC`)).toBe(
      '<span class="ansi-b ansi-fg-2">A</span><span class="ansi-b">B</span>C',
    );
  });

  it('supports 256 colors: palette, cube and gray ramp', () => {
    expect(ansiToHtml(`${E}38;5;9mx`)).toBe('<span class="ansi-fg-9">x</span>');
    expect(ansiToHtml(`${E}38;5;196mx`)).toBe('<span style="color:#ff0000">x</span>');
    expect(ansiToHtml(`${E}38;5;21mx`)).toBe('<span style="color:#0000ff">x</span>');
    expect(ansiToHtml(`${E}38;5;243mx`)).toBe('<span style="color:#767676">x</span>');
    expect(ansiToHtml(`${E}38;5;232mx`)).toBe('<span style="color:#080808">x</span>');
  });

  it('supports truecolor and clamps out-of-range values', () => {
    expect(ansiToHtml(`${E}38;2;255;128;0mx`)).toBe('<span style="color:#ff8000">x</span>');
    expect(ansiToHtml(`${E}38;2;999;-5;7mx`)).toBe('<span style="color:#ff0007">x</span>');
  });

  it('ignores an invalid 256 index', () => {
    expect(ansiToHtml(`${E}38;5;300mx`)).toBe('x');
  });

  it('accepts colon separators and an empty parameter as reset', () => {
    expect(ansiToHtml(`${E}38:5:9mx${E}mY`)).toBe('<span class="ansi-fg-9">x</span>Y');
  });

  it('applies the sequence from the fixture style (nested resets)', () => {
    const s = `[${E}38;5;243m░░${E}39m${E}1m${E}38;5;39m██${E}22m${E}39m]`;
    expect(ansiToHtml(s)).toBe(
      '[<span style="color:#767676">░░</span><span class="ansi-b" style="color:#00afff">██</span>]',
    );
  });

  it('keeps newlines and tabs, drops carriage returns and other controls', () => {
    expect(ansiToHtml('a\r\nb\tc\rd\x00e\x07f')).toBe('a\nb\tcdef');
  });

  it('drops background colors, inverse and other unsupported attributes', () => {
    expect(ansiToHtml(`${E}41mred bg${E}0m ${E}7minv${E}27m ${E}48;5;9mx`)).toBe('red bg inv x');
  });

  it('strips cursor movement, erase and private-mode sequences', () => {
    expect(ansiToHtml(`a${E}2K${E}1;1H${E}?25l${E}3Ab`)).toBe('ab');
  });

  it('strips OSC sequences including hyperlinks and titles', () => {
    expect(ansiToHtml('a\x1b]0;title\x07b')).toBe('ab');
    expect(ansiToHtml('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('never lets text become markup', () => {
    const out = ansiToHtml(`${E}31m<img src=x onerror=alert(1)>${E}0m`);
    expect(out).toBe('<span class="ansi-fg-1">&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(out).not.toContain('<img');
  });

  it('does not leak escape bytes', () => {
    expect(ansiToHtml(`x${E}31m y ${E}0m z\x1bM`)).not.toContain('\x1b');
  });
});

describe('stripAnsi', () => {
  it('removes every sequence', () => {
    expect(stripAnsi(`${E}1;31mred${E}0m \x1b]0;t\x07ok`)).toBe('red ok');
  });
});
