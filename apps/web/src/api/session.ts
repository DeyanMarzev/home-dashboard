import { useSyncExternalStore } from 'react';

/** Set when any request finds the Cloudflare Access session expired. */
let expired = false;
const listeners = new Set<() => void>();

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  listeners.forEach((l) => l());
}

export function useSessionExpired(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => expired,
  );
}

/** Set when the API says an admin turned this person's access off (403 USER_DISABLED). */
let disabled = false;
const disabledListeners = new Set<() => void>();

export function markAccessDisabled(): void {
  if (disabled) return;
  disabled = true;
  disabledListeners.forEach((l) => l());
}

export function useAccessDisabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      disabledListeners.add(l);
      return () => disabledListeners.delete(l);
    },
    () => disabled,
  );
}
