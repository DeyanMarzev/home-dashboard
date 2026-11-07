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
