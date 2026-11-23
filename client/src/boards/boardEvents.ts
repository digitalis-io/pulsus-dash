/**
 * The board's event markers (plan #64 Part C §3.8, §4.1): one annotations request per resolved
 * window for the whole board, never one per panel, under the `['data', …]` key prefix, so Refresh
 * now cancels and reruns it with the panels (`useTimeContext().refreshNow`). A window change makes a
 * new key; the old request is aborted, and the old markers stay until the new ones arrive. Panels
 * scrolling in or out make no request. A failure shows a notice and no markers; the panels are
 * unaffected. `BoardPage` provides the result to every panel through `BoardEventsContext`.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createContext, useMemo } from 'react';
import { useApi } from '../app/providers';
import type { Annotation } from '../api/types';
import type { EventMarker } from '../engine/api';
import { useTimeContext } from '../state/useTimeContext';

export interface BoardEvents {
  readonly markers: readonly EventMarker[];
  /** The server held more than the 500 newest in the window. */
  readonly truncated: boolean;
  /** The request failed (not an abort); `markers` is then empty. */
  readonly failed: boolean;
}

const NO_MARKERS: readonly EventMarker[] = Object.freeze([]);

export const NO_EVENTS: BoardEvents = Object.freeze({
  markers: NO_MARKERS,
  truncated: false,
  failed: false,
});

const FAILED: BoardEvents = Object.freeze({ markers: NO_MARKERS, truncated: false, failed: true });

/** The board's markers; outside a board, none. */
export const BoardEventsContext = createContext<BoardEvents>(NO_EVENTS);

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError';
}

const byTimeThenId = (a: EventMarker, b: EventMarker): number =>
  a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The API's annotations as engine markers, in (atMs, id) order. */
export function toMarkers(items: readonly Annotation[]): EventMarker[] {
  return items
    .map((a) => ({ id: a.id, atMs: a.at, endMs: a.end_at, kind: a.kind, title: a.text }))
    .sort(byTimeThenId);
}

/** The markers of the resolved window; no request while `enabled` is false. */
export function useBoardEvents(tenant: string, enabled: boolean): BoardEvents {
  const api = useApi();
  const { window: w } = useTimeContext();
  const { fromMs, toMs } = w;
  const q = useQuery({
    queryKey: ['data', 'events', tenant, fromMs, toMs],
    queryFn: ({ signal }) => api.listAnnotations(tenant, { fromMs, toMs }, signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const failed = q.isError && !isAbort(q.error);
  const { data } = q;
  return useMemo(() => {
    if (failed) return FAILED;
    if (data === undefined) return NO_EVENTS;
    return { markers: toMarkers(data.items), truncated: data.truncated, failed: false };
  }, [failed, data]);
}
