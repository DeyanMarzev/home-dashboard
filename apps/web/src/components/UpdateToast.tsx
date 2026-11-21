import { useRegisterSW } from 'virtual:pwa-register/react';

/** The installed app can stay open for days: look for a new version every hour. */
const UPDATE_CHECK_MS = 60 * 60_000;

/**
 * Registers the service worker and offers a new version when one is waiting (docs/09 §1:
 * "New version available · Reload"). Nothing shows in `vite dev`, where there's no worker.
 */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => {
        if (navigator.onLine) registration.update().catch(() => undefined);
      }, UPDATE_CHECK_MS);
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="toast" role="status">
      <span>New version available</span>
      <button type="button" className="toast-action" onClick={() => void updateServiceWorker()}>
        Reload
      </button>
      <button
        type="button"
        className="toast-close"
        aria-label="Not now"
        onClick={() => setNeedRefresh(false)}
      >
        ×
      </button>
    </div>
  );
}
