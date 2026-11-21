import { DeviceItemSchema, type DeviceItem } from '@home/shared';
import { sendJson } from '../api/client.js';

/**
 * Push on this device (docs/09 §7 This device). The service worker only exists in the built
 * app, so in `vite dev` this reports "unsupported".
 */
export type PushState =
  | { kind: 'unsupported' }
  | { kind: 'blocked' }
  | { kind: 'off' }
  | { kind: 'on'; subscription: PushSubscription };

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    import.meta.env.PROD
  );
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'blocked' };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription && Notification.permission === 'granted'
    ? { kind: 'on', subscription }
    : { kind: 'off' };
}

/** VAPID public key (base64url) → the bytes pushManager.subscribe wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function register(subscription: PushSubscription): Promise<DeviceItem> {
  return sendJson<DeviceItem>('POST', '/api/me/devices', { subscription: subscription.toJSON() });
}

/** "Turn on notifications": only ever from a button tap (browsers require a gesture). */
export async function turnOn(vapidPublicKey: string): Promise<DeviceItem> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed');
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(vapidPublicKey),
    }));
  return DeviceItemSchema.parse(await register(subscription));
}

/** "Turn off on this phone": forget it here and on the Pi. */
export async function turnOff(subscription: PushSubscription, deviceId: number | null) {
  await subscription.unsubscribe();
  if (deviceId !== null) await sendJson('DELETE', `/api/me/devices/${deviceId}`);
}

/**
 * On every app start with permission granted: re-send the subscription (refreshes "last
 * seen", re-links the phone if someone else signed in). Returns this device's id.
 */
export async function resyncPush(): Promise<number | null> {
  const state = await pushState();
  if (state.kind !== 'on') return null;
  try {
    return (await register(state.subscription)).id;
  } catch {
    return null;
  }
}

let startup: Promise<number | null> | null = null;

/** The startup re-sync, run once per app start (Settings reuses its result). */
export function syncOnStart(): Promise<number | null> {
  startup ??= resyncPush();
  return startup;
}
