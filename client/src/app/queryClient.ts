import { QueryClient } from '@tanstack/react-query';

/** Production query defaults (§3.4 of plan #57). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
    },
  });
}
