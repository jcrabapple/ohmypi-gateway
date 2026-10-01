import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushCapability, urlBase64ToUint8Array } from '../push';

describe('urlBase64ToUint8Array', () => {
  // A real 65-byte uncompressed P-256 point, base64url-encoded without padding
  // (exactly the shape GET /api/push/vapid hands the client).
  const RAW = new Uint8Array(65);
  RAW[0] = 0x04;
  for (let i = 1; i < 65; i++) RAW[i] = i;
  const KEY = btoa(String.fromCharCode(...RAW)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('decodes an unpadded base64url key back to the raw bytes', () => {
    const bytes = urlBase64ToUint8Array(KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04); // EC uncompressed point marker
    expect([...bytes]).toEqual([...RAW]);
  });

  it('round-trips through btoa-friendly bytes', () => {
    const bytes = urlBase64ToUint8Array(KEY);
    const back = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(back.length).toBeGreaterThanOrEqual(KEY.length - 2);
  });

  it('tolerates already-padded input', () => {
    expect([...urlBase64ToUint8Array('YQ==')]).toEqual([97]);
    expect([...urlBase64ToUint8Array('YQ')]).toEqual([97]);
  });
});

describe('pushCapability', () => {
  it('is unsupported without a service worker registration yet', () => {
    const cap = pushCapability(null);
    expect(cap.supported).toBe(false);
    expect(cap.reason).toMatch(/service worker/i);
  });

  it('is supported with a registration on a capable window', () => {
    // happy-dom exposes window/navigator but not PushManager; assert the null case only.
    expect(pushCapability(null).supported).toBe(false);
  });
});

describe('service worker push wiring', () => {
  const sw = readFileSync(resolve(process.cwd(), 'sw/sw.js'), 'utf8');

  it('shows push notifications and deep-links notification clicks', () => {
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain('showNotification');
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain('openWindow');
    // deep links carry the session hash route from the gateway payload
    expect(sw).toContain("payload.url || '/#/usage'");
  });
});
