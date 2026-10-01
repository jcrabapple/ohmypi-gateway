// Web Push for "needs you": subscribe this device so the gateway can push
// when a dialog is waiting and nobody is watching the session. Requires the
// installed service worker, a secure context, and PushManager support.
// iOS only allows this inside the installed PWA.

const VAPID_ENDPOINT = '/api/push/vapid';

export interface PushCapability {
  supported: boolean;
  /** Why not, when supported is false. */
  reason: string;
}

export function pushCapability(sw: ServiceWorkerRegistration | null): PushCapability {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return { supported: false, reason: 'This browser has no service worker support.' };
  }
  if (!('PushManager' in window)) {
    return { supported: false, reason: 'This browser has no push support.' };
  }
  if (!sw) return { supported: false, reason: 'The app is still loading its service worker.' };
  return { supported: true, reason: '' };
}

/** The VAPID key arrives base64url; PushManager wants raw bytes. */
export function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function vapidKey(): Promise<string> {
  const res = await fetch(VAPID_ENDPOINT);
  if (!res.ok) throw new Error(`gateway has no push key (${res.status})`);
  const data = (await res.json()) as { publicKey?: string };
  if (typeof data.publicKey !== 'string' || !data.publicKey) {
    throw new Error('gateway push key missing');
  }
  return data.publicKey;
}

async function sendToGateway(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gateway rejected the subscription (${res.status})`);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** Current device state: subscribed, or why not. Never prompts. */
export async function pushStatus(): Promise<
  { state: 'on' } | { state: 'off' } | { state: 'unsupported'; reason: string } | { state: 'blocked' }
> {
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return { state: 'blocked' };
  }
  const sw = await registration();
  const cap = pushCapability(sw);
  if (!cap.supported) return { state: 'unsupported', reason: cap.reason };
  const sub = await sw!.pushManager.getSubscription();
  return sub ? { state: 'on' } : { state: 'off' };
}

/**
 * Ask permission (call from a click handler), subscribe with the gateway's
 * VAPID key, and register the subscription. Throws with a user-readable
 * message on failure; the caller surfaces it.
 */
export async function enablePush(): Promise<void> {
  if (typeof Notification === 'undefined') throw new Error('This browser has no notification support.');
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== 'granted') throw new Error('Notifications are not allowed.');
  const sw = await registration();
  const cap = pushCapability(sw);
  if (!cap.supported) throw new Error(cap.reason);
  const key = await vapidKey();
  const sub = await sw!.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await sendToGateway('/api/push/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
  });
}

/** Unsubscribe this device locally and on the gateway. Best effort. */
export async function disablePush(): Promise<void> {
  const sw = await registration();
  const sub = await sw?.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await sendToGateway('/api/push/unsubscribe', { endpoint }).catch(() => {});
  }
}
