import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { SessionExpiredError } from './api/client.js';
import { LiveProvider } from './api/live.js';
import { markSessionExpired } from './api/session.js';
import { NowProvider } from './lib/now.js';
import { router } from './router.js';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof SessionExpiredError) markSessionExpired();
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failures, error) => !(error instanceof SessionExpiredError) && failures < 2,
      refetchOnWindowFocus: true,
    },
  },
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
