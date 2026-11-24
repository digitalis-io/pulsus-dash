/**
 * The log volume of Explore › Logs (plan #66 Part C §3.7; SRF-033, PRF-030): the URL text sent as
 * is (ADR-0021 §2) with the window and the step's width, as one TanStack query under the
 * `['data']` prefix: a newer key aborts the older request, and the shell's refresh cancels and
 * reruns it. The last success of the tenant is kept (D-RUN).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useApi } from '../app/providers';
import type { VolumeResult } from '../data/decode';
import type { StepWidth } from './stepWidth';

/** `['data', 'logs', 'volume', tenant, q, fromMs, toMs, stepMs]`: under the shell's refresh rule. */
export function logsVolumeKey(
  tenant: string,
  q: string,
  w: { readonly fromMs: number; readonly toMs: number },
  stepMs: number,
): readonly unknown[] {
  return ['data', 'logs', 'volume', tenant, q, w.fromMs, w.toMs, stepMs];
}

export interface LogsVolume {
  /** The last success of this tenant (D-RUN); null when `q` is ''. */
  readonly shown: VolumeResult | null;
  /** The current key's error; null when none or an `AbortError`. */
  readonly error: unknown;
  readonly fetching: boolean;
  /** Cancels the key's request in flight, then fetches again. */
  rerun(): void;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

interface Last {
  readonly tenant: string;
  readonly result: VolumeResult;
}

export function useLogsVolume(a: {
  readonly tenant: string;
  readonly q: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly step: StepWidth | null;
  /** q not blank, no refusal, step known. */
  readonly enabled: boolean;
}): LogsVolume {
  const api = useApi();
  const queryClient = useQueryClient();
  const { tenant, q, step } = a;
  const { fromMs, toMs } = a.window;
  const stepMs = step?.stepMs ?? null;
  const key = useMemo(
    () =>
      stepMs === null
        ? ['data', 'logs', 'volume', tenant, q, null]
        : logsVolumeKey(tenant, q, { fromMs, toMs }, stepMs),
    [tenant, q, fromMs, toMs, stepMs],
  );

  const query = useQuery({
    queryKey: key,
    enabled: a.enabled && step !== null,
    retry: false,
    structuralSharing: false,
    placeholderData: (prev: VolumeResult | undefined, prevQuery) =>
      prevQuery?.queryKey[3] === tenant ? prev : undefined,
    // `step` is part of the key through `stepMs`; its width changes only with the step.
    queryFn: ({ signal }): Promise<VolumeResult> => {
      if (step === null) throw new Error('logs volume: a run without its step');
      return api.queryVolume(tenant, { query: q, fromMs, toMs, widthPx: step.widthPx }, signal);
    },
  });

  const refetch = query.refetch;
  const rerun = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: key, exact: true }).then(() => refetch());
  }, [queryClient, key, refetch]);

  const [last, setLast] = useState<Last | null>(null);
  const data = query.data;
  // Kept while rendering (not in an effect): the last success of this key that is not a placeholder.
  if (
    data !== undefined &&
    !query.isPlaceholderData &&
    (last?.tenant !== tenant || last.result !== data)
  ) {
    setLast({ tenant, result: data });
  }
  const kept = last?.tenant === tenant ? last.result : null;
  const shown = q === '' ? null : query.isError ? kept : (data ?? kept);
  const error = query.isError && !isAbort(query.error) ? query.error : null;

  return useMemo(
    () => ({ shown, error, fetching: query.isFetching, rerun }),
    [shown, error, query.isFetching, rerun],
  );
}
