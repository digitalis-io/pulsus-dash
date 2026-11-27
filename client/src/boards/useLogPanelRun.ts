/**
 * The run of one board LogQL panel (plan #67 §3.3, §4; ADR-0021 §2): the panel sends its raw text,
 * the board variables it references, the board window and its body width; nothing is planned here.
 * The saved vis picks the path (`logPanelPath`):
 *
 * - **Stream** (Auto, Logs): a `LogPager`, started while the panel is visible and kept while it is
 *   scrolled out unless its input or generation changes (T07-012, `streamInput`). The generation
 *   is `refreshEpoch.runSeq.driftSeq`: the shell's refresh, the editor's Run of the same text and
 *   drift's Run again are new pagers. The panel behind its open editor holds none.
 * - **Frame** (Bars, Line, Heatmap, Stat): one TanStack query under the panel key, as a PromQL
 *   panel's (the window epoch, the refresh, the preview sharing it), whose function is
 *   `fetchLogFrame`: a kind probe and, for Bars, the volume in parallel.
 *
 * The order, wrap and drift count are this hook's state, never saved and not in the URL. The
 * language is loaded only for the diagnostics of an error. Main thread; no timers.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../app/providers';
import { isApiError } from '../api/types';
import { logGrid } from '../data/step';
import type { Diagnostic } from '../editor/lang/types';
import { firstPageError } from '../explore/logsRun';
import { useStepWidth } from '../explore/stepWidth';
import { refusalOf, type Refusal } from '../explore/useExploreRun';
import { useLogPager, useLogPagerState } from '../logs/useLogPager';
import { useTimeContext } from '../state/useTimeContext';
import { BoardRunContext } from './boardRunContext';
import { fetchLogFrame, logPanelPath, streamInput, streamMeta, type StreamRun } from './logPanel';
import { PENDING_KINDS } from './options';
import {
  panelIdleKey,
  panelRunKey,
  sameExceptWindow,
  sameKey,
  type PanelOutcome,
  type PanelState,
  type PanelStream,
} from './panelRun';
import { NO_STALE, isAbort, missingOf, type PanelRun, type PanelRunInput } from './usePanelRun';
import { useQueryLanguage } from './useQueryLanguage';
import { panelVars, referencedVariables } from './variableRefs';

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);
const NO_NAMES: readonly string[] = Object.freeze([]);
const NO_RETRY = (): void => undefined;

export function useLogPanelRun(a: PanelRunInput, active: boolean): PanelRun {
  const api = useApi();
  const { vars, timeReady } = useContext(BoardRunContext);
  const { window, refreshEpoch } = useTimeContext();
  const { tenant, panel, text, enabled, widthPx } = a;
  const runSeq = a.runSeq ?? 0;
  const editing = a.editing ?? false;
  const { fromMs, toMs } = window;
  const { lang } = useQueryLanguage(active ? 'logql' : null);

  const hint = useMemo(() => referencedVariables(text).filter((n) => !vars.has(n)), [text, vars]);
  const refusedEarly = useMemo(() => refusalOf(text), [text]);
  const pre: PanelState | null = !active
    ? null
    : PENDING_KINDS.has(panel.vis.kind)
      ? 'kindUnavailable'
      : text.trim() === ''
        ? 'empty'
        : refusedEarly !== null
          ? 'refused'
          : hint.length > 0
            ? 'variable'
            : null;
  // Nothing is sent while inactive, blocked or before the board's time is set (§4.6).
  const runnable = active && pre === null && timeReady;
  const path = logPanelPath(panel.vis.kind);
  const sentPairs = useMemo(() => panelVars(text, vars), [text, vars]);
  const sent = useMemo(() => Object.fromEntries(sentPairs), [sentPairs]);
  const varsJson = useMemo(() => JSON.stringify(sentPairs), [sentPairs]);

  // The stream path (§3.3): order, wrap and drift are this panel's own, not saved (Q1).
  const [dir, setDir] = useState<'backward' | 'forward'>('backward');
  const [wrap, setWrap] = useState(false);
  const [driftSeq, setDriftSeq] = useState(0);
  const rerun = useCallback(() => {
    setDriftSeq((n) => n + 1);
  }, []);
  const step = useStepWidth(window, timeReady ? widthPx : null);
  const streamPath = active && path === 'stream';
  const next = useMemo<StreamRun | null>(
    () =>
      !runnable || path !== 'stream' || step === null
        ? null
        : {
            input: {
              tenant,
              query: text,
              vars: sent,
              fromMs,
              toMs,
              widthPx: step.widthPx,
              direction: dir,
            },
            generation: `${String(refreshEpoch)}.${String(runSeq)}.${String(driftSeq)}`,
          },
    [runnable, path, step, tenant, text, sent, fromMs, toMs, dir, refreshEpoch, runSeq, driftSeq],
  );
  // The run held across renders (T07-012): set while rendering, every render; null disposes.
  const [held, setHeld] = useState<StreamRun | null>(null);
  const run = editing ? null : streamInput(enabled, held, next);
  if (run !== held) setHeld(run);
  const pager = useLogPager(run?.input ?? null, api, run?.generation ?? '');
  const state = useLogPagerState(pager);

  // The frame path (§3.3): the PromQL panel's key and options, `fetchLogFrame` as its function.
  const stepMs =
    timeReady && widthPx !== null && widthPx > 0
      ? (logGrid(fromMs, toMs, widthPx)?.stepMs ?? null)
      : null;
  const runKey = useMemo(
    () =>
      runnable && path !== 'stream' && stepMs !== null
        ? panelRunKey(
            tenant,
            panel.id,
            { text, vars: varsJson },
            path,
            stepMs,
            { fromMs, toMs },
            null,
          )
        : null,
    [runnable, path, stepMs, tenant, panel.id, text, varsJson, fromMs, toMs],
  );
  const key = useMemo(
    () => runKey ?? panelIdleKey(tenant, panel.id, text),
    [runKey, tenant, panel.id, text],
  );
  // Read by the query function: a width change within one step does not refetch.
  const widthRef = useRef(widthPx);
  useLayoutEffect(() => {
    widthRef.current = widthPx;
  });
  const query = useQuery({
    queryKey: key,
    enabled: enabled && runKey !== null,
    staleTime: Infinity,
    retry: false,
    structuralSharing: false,
    placeholderData: (prev: PanelOutcome | undefined, prevQuery) =>
      prevQuery !== undefined &&
      prevQuery.state.status !== 'error' &&
      sameExceptWindow(prevQuery.queryKey, key)
        ? prev
        : undefined,
    queryFn: async ({ signal, queryKey }): Promise<PanelOutcome> => {
      if (path === 'stream') throw new Error('panel: a frame run on the stream path');
      const o = await fetchLogFrame(
        api,
        tenant,
        { query: text, fromMs, toMs, widthPx: widthRef.current ?? 0, vars: sent },
        path === 'logs-bars',
        signal,
      );
      return { key: queryKey, ...o };
    },
  });

  const frameRejection =
    runKey !== null && query.isError && !isAbort(query.error) ? query.error : null;
  const rejection = streamPath ? firstPageError(state) : frameRejection;
  const serverMissing = useMemo(() => missingOf(rejection), [rejection]);
  const serverRefused = isApiError(rejection, 'queryTooLong');
  const blocked: PanelState | null =
    pre ?? (serverMissing !== null ? 'variable' : serverRefused ? 'refused' : null);
  const missing = pre === 'variable' ? hint : (serverMissing ?? NO_NAMES);
  const refusal: Refusal | null =
    pre === 'refused' ? refusedEarly : pre === null && serverRefused ? 'tooLong' : null;
  const error = blocked === null ? rejection : null;

  const diagnostics = useMemo(
    () =>
      isApiError(error, 'queryInvalid') && lang !== null
        ? // The server maps the position into the raw text (ADR-0021 §3): the identity.
          lang.diagnosticsOf(text, error, (i) => i, text)
        : NO_DIAGNOSTICS,
    [error, text, lang],
  );

  const outcome = runKey === null ? null : (query.data ?? null);
  const expanded = streamPath
    ? (streamMeta(state).planned?.expanded ?? null)
    : runKey === null
      ? null
      : query.isError
        ? isApiError(rejection)
          ? (rejection.detail.planned?.expanded ?? null)
          : null
        : outcome !== null && !query.isPlaceholderData && sameKey(outcome.key, runKey)
          ? outcome.planned.expanded
          : null;

  const stream = useMemo<PanelStream | null>(
    () => (streamPath ? { pager, state, wrap, setWrap, setDirection: setDir, rerun } : null),
    [streamPath, pager, state, wrap, rerun],
  );
  const ready = blocked === null && (streamPath ? next !== null : runKey !== null);
  const fetching = !streamPath && query.isFetching;
  const runStep = streamPath ? (step?.stepMs ?? null) : stepMs;
  return useMemo(
    () => ({
      text,
      blocked,
      missing,
      refusal,
      ready,
      outcome,
      error,
      diagnostics,
      fetching,
      stepMs: runStep,
      expanded,
      stream,
      placeholder: false,
      retry: NO_RETRY,
      store: 'off' as const,
      rank: null,
      stale: NO_STALE,
    }),
    [
      text,
      blocked,
      missing,
      refusal,
      ready,
      outcome,
      error,
      diagnostics,
      fetching,
      runStep,
      expanded,
      stream,
    ],
  );
}
