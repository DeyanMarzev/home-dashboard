import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** The system's light/dark setting, live (styles.css switches its tokens on the same query). */
export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(QUERY).matches ? 'dark' : 'light'),
    () => 'light',
  );
}
