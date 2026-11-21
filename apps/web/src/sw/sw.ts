/// <reference lib="webworker" />
// The app's service worker (docs/09 §1, §6): precaches the app shell, nothing else.
// API calls and Cloudflare Access (/cdn-cgi) always go to the network untouched.
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/**
 * Page loads go to the network first, so an expired Access session redirects to the login
 * like a normal site (a cached index.html would hide it, and "Reload" would never sign in
 * again). Only when the network fails does the cached shell open the app offline.
 */
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      try {
        return await fetch(request);
      } catch {
        return (await matchPrecache('/index.html')) ?? Response.error();
      }
    },
    { denylist: [/^\/api\//, /^\/cdn-cgi\//] },
  ),
);

// "New version available · Reload" (UpdateToast) asks the waiting worker to take over.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// --- Push notifications (docs/09 §6) ---------------------------------------------------------

interface PushData {
  phase?: string;
  level?: string | null;
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  ts?: string;
}

// Every push must show a notification (Chrome requires userVisibleOnly).
self.addEventListener('push', (event: PushEvent) => {
  let m: PushData;
  try {
    m = (event.data?.json() as PushData | undefined) ?? {};
  } catch {
    m = {};
  }
  const options: NotificationOptions & { renotify?: boolean; timestamp?: number } = {
    body: m.body ?? 'Open the app for details',
    tag: m.tag,
    renotify: Boolean(m.tag) && m.phase !== 'resolved',
    requireInteraction: m.level === 'alert' && m.phase !== 'resolved',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    timestamp: m.ts ? Date.parse(m.ts) : Date.now(),
    data: { url: m.url ?? '/' },
  };
  event.waitUntil(self.registration.showNotification(m.title ?? 'Home', options));
});

// Tapping one opens (or focuses) the app on the alert's page.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | null)?.url ?? '/';
  const url = new URL(target, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ type: 'navigate', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

// The browser replaced the subscription: subscribe again and tell the API (best effort; the
// app also re-syncs on every start).
self.addEventListener('pushsubscriptionchange', (event: Event) => {
  const e = event as ExtendableEvent & { oldSubscription?: PushSubscription | null };
  const key = e.oldSubscription?.options.applicationServerKey;
  if (!key) return;
  e.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((sub) =>
        fetch('/api/me/devices', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        }),
      )
      .then(() => undefined)
      .catch(() => undefined),
  );
});
