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
