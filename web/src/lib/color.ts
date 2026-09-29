// WCAG colour math for #rrggbb values. themes.css is the single source of truth for the
// palettes; this is only arithmetic on whatever hex a theme or a custom accent supplies.

const HEX = /^#([0-9a-f]{6})$/i;

export function isHex(value: string): boolean {
  return HEX.test(value.trim());
}

function channels(hex: string): [number, number, number] {
  const m = HEX.exec(hex.trim());
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const DARK_INK = '#000000';
const LIGHT_INK = '#ffffff';

/** Black or white, whichever reads better on `background`. Used for text on a custom accent. */
export function readableInk(background: string): string {
  return contrast(DARK_INK, background) >= contrast(LIGHT_INK, background) ? DARK_INK : LIGHT_INK;
}
