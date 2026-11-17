import { isLoopApiError } from '@super-loop/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { UiProvider } from './components/ui.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 实时事件会主动刷新，这里不必频繁轮询
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // 4xx（鉴权、不存在）不重试
      retry: (count, error) => (isLoopApiError(error) && !error.retryable ? false : count < 3),
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <App />
      </UiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
