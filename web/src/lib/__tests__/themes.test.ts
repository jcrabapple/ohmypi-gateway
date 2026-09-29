import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrast, isHex, readableInk } from '../color';

// themes.css is the single source of truth; this reads it rather than keeping a second table.
// vitest runs from web/, and returns an empty string for ?raw css, so read the file directly.
const css = readFileSync(resolve(process.cwd(), 'src/styles/themes.css'), 'utf8');

type Palette = Record<string, string>;

function parseThemes(source: string): Record<string, Palette> {
  const themes: Record<string, Palette> = {};
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectors, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const names = [...selectors!.matchAll(/\[data-theme='(\w+)'\]/g)].map((m) => m[1]!);
    if (/(^|,)\s*:root\s*(,|$)/.test(selectors!)) names.push('terminal');
    const vars: Palette = {};
    for (const [, k, v] of body!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[k!] = v!.trim();
    for (const n of names) themes[n] = { ...themes[n], ...vars };
  }
  return themes;
}

const themes = parseThemes(css);
const NAMES = ['terminal', 'graphite', 'paper', 'contrast'] as const;
const SURFACES = ['--bg', '--canvas', '--surface', '--inset', '--field'] as const;
const AA = 4.5;

describe('theme palettes', () => {
  it('defines the four presets with hex colours for every token the checks use', () => {
    for (const name of NAMES) {
      const t = themes[name]!;
      for (const k of [...SURFACES, '--ink', '--ink-2', '--ink-3', '--accent', '--accent-ink', '--warn', '--err']) {
        expect(isHex(t[k] ?? ''), `${name} ${k}`).toBe(true);
      }
    }
  });

  for (const name of NAMES) {
    describe(name, () => {
      const t = themes[name]!;
      for (const ink of ['--ink', '--ink-2', '--ink-3'] as const) {
        for (const surface of SURFACES) {
          it(`${ink} on ${surface} meets 4.5:1`, () => {
            expect(contrast(t[ink]!, t[surface]!)).toBeGreaterThanOrEqual(AA);
          });
        }
      }
      it('--accent-ink on --accent meets 4.5:1', () => {
        expect(contrast(t['--accent-ink']!, t['--accent']!)).toBeGreaterThanOrEqual(AA);
      });
      it('--accent as text on canvas and surface meets 4.5:1', () => {
        expect(contrast(t['--accent']!, t['--canvas']!)).toBeGreaterThanOrEqual(AA);
        expect(contrast(t['--accent']!, t['--surface']!)).toBeGreaterThanOrEqual(AA);
      });
      it('--warn and --err text on canvas meets 4.5:1', () => {
        expect(contrast(t['--warn']!, t['--canvas']!)).toBeGreaterThanOrEqual(AA);
        expect(contrast(t['--err']!, t['--canvas']!)).toBeGreaterThanOrEqual(AA);
      });
    });
  }
});

describe('color helpers', () => {
  it('computes known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#777777')).toBe(1);
  });

  it('picks the readable ink for a custom accent', () => {
    expect(readableInk('#fde047')).toBe('#000000');
    expect(readableInk('#1e3a8a')).toBe('#ffffff');
    for (const bg of ['#22c55e', '#ef4444', '#a855f7', '#0ea5e9', '#f97316']) {
      expect(contrast(readableInk(bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('rejects non-hex input', () => {
    expect(() => contrast('red', '#fff')).toThrow();
  });
});
