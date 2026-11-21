import { useSyncExternalStore } from 'react';

/** Chrome's install prompt event (not in the DOM typings yet). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallState {
  /** Chrome offered to install: the Install app button can show. */
  canInstall: boolean;
  /** Running as the installed app (layout tweaks only, never to gate features). */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canInstall: false, installed: false };
const listeners = new Set<() => void>();

function set(next: Partial<InstallState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/**
 * Call once at startup: Chrome fires `beforeinstallprompt` early, before any page that shows
 * the button is open (docs/09 § Install flow).
 */
export function watchInstall(): void {
  const standalone = window.matchMedia?.('(display-mode: standalone)');
  set({ installed: standalone?.matches ?? false });
  standalone?.addEventListener('change', (e) => set({ installed: e.matches }));
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for the button instead of Chrome's mini-bar
    deferred = e as BeforeInstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canInstall: false, installed: true });
  });
}

/** Shows Chrome's install dialog. The event can only be used once. */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  set({ canInstall: false });
  await event.prompt();
  await event.userChoice;
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
