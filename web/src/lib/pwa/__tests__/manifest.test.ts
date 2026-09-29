import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')) as {
  name: string; short_name: string; display: string; start_url: string; theme_color: string; background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('manifest', () => {
  it('is an installable standalone app on the terminal canvas colour', () => {
    expect(manifest.name).toBe('omp');
    expect(manifest.short_name).toBe('omp');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toBe('#0e1210');
    expect(manifest.background_color).toBe('#0e1210');
  });

  it('lists 192, 512 and a maskable 512 icon that exist at those sizes', () => {
    const want = [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']];
    for (const [sizes, purpose] of want) {
      const icon = manifest.icons.find((i) => i.sizes === sizes && i.purpose === purpose);
      expect(icon, `${sizes} ${purpose}`).toBeDefined();
      expect(icon!.type).toBe('image/png');
      const [w, h] = pngSize(resolve(root, 'public', icon!.src.slice(1)));
      expect(`${w}x${h}`).toBe(sizes);
    }
  });

  it('ships an apple touch icon and links everything from index.html', () => {
    expect(pngSize(resolve(root, 'public/apple-touch-icon.png'))).toEqual([180, 180]);
    expect(statSync(resolve(root, 'public/apple-touch-icon.png')).size).toBeGreaterThan(0);
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="theme-color" content="#0e1210"');
  });
});
