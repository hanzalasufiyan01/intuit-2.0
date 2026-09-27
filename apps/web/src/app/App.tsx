import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider, type createMemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/auth-context';
import { ApiError } from '../services/api-client';
import { routes } from './routes';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Authorization failures are definitive; do not retry them.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
          failureCount < 2,
        refetchOnWindowFocus: true,
      },
    },
  });
}

type AppRouter = ReturnType<typeof createBrowserRouter> | ReturnType<typeof createMemoryRouter>;

/** Application providers: TanStack Query -> authentication state -> router. */
export function App({ router, queryClient }: { router?: AppRouter; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [appRouter] = useState(() => router ?? createBrowserRouter(routes));
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={appRouter} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
