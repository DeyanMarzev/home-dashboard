import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { ApiError, SessionExpiredError } from './api/client.js';
import { LiveProvider } from './api/live.js';
import { markAccessDisabled, markSessionExpired } from './api/session.js';
import { watchInstall } from './lib/install.js';
import { syncOnStart } from './lib/push.js';
import { NowProvider } from './lib/now.js';
import { router } from './router.js';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof SessionExpiredError) markSessionExpired();
      else if (error instanceof ApiError && error.code === 'USER_DISABLED') markAccessDisabled();
    },
  }),
  defaultOptions: {
    queries: {
      // Retrying can't fix a sign-in or a permission problem.
      retry: (failures, error) =>
        !(error instanceof SessionExpiredError) &&
        !(error instanceof ApiError && error.status === 403) &&
        failures < 2,
      refetchOnWindowFocus: true,
    },
  },
});

watchInstall();
void syncOnStart();

// A tapped notification asks an open app to show the alert's page (docs/09 §6).
navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; url?: string } | null;
  if (data?.type !== 'navigate' || !data.url) return;
  const url = new URL(data.url, window.location.origin);
  if (url.origin === window.location.origin) void router.navigate(url.pathname + url.hash);
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <NowProvider>
          <RouterProvider router={router} />
        </NowProvider>
      </LiveProvider>
    </QueryClientProvider>
  </StrictMode>,
);
