/**
 * The page's metric-metadata query (plan #63 Part B §3.3): one TanStack query per tenant, used by
 * the planner (metric types) and, through `track`, by the editor's completion. It has no editor
 * import, so the page can use it before the editor chunk loads.
 */
import { queryOptions } from '@tanstack/react-query';
import type { Api } from '../api/Api';

export const PROM_METADATA_LIMIT = 10_000;
export const PROM_METADATA_STALE_MS = 300_000;

export const promMetadataQuery = (api: Api, tenant: string) =>
  queryOptions({
    queryKey: ['prom', tenant, 'metadata'] as const,
    queryFn: ({ signal }) => api.promMetadata(tenant, { limit: PROM_METADATA_LIMIT }, signal),
    staleTime: PROM_METADATA_STALE_MS,
    retry: false,
  });
