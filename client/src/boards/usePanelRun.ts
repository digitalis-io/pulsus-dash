/**
 * The run of one board panel (plan #64 §3.2, §4.1–§4.3; ADR-0021): the panel sends its raw text,
 * the board variables it references, the board window and its body width (range) or its step
 * (instant), and reads every fact about the sent query from the server's `planned`. One TanStack
 * query under `['data', 'panel', …]` (the shell's refresh reaches it; a new key aborts the old
 * request, PRF-030), fresh within the window epoch only (`staleTime: Infinity`, `BoardRunProvider`).
 * A window or step change keeps the previous outcome as the placeholder; any other change does not.
 * A LogQL panel runs through `useLogPanelRun` (plan #67 §3.3); both hooks are called on every render
 * and the inactive one sends nothing and loads no language.
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { useApi } from '../app/providers';
import { isApiError, type PanelSpec } from '../api/types';
import { promGrid } from '../data/step';
import type { Diagnostic } from '../editor/lang/types';
import { refusalOf, runKind, type Refusal } from '../explore/useExploreRun';
import { useTimeContext } from '../state/useTimeContext';
import { fromInstant, fromRange } from '../vis/autovis';
import { BoardRunContext } from './boardRunContext';
import {
  panelIdleKey,
  panelRunKey,
  sameExceptWindow,
  sameKey,
  type PanelOutcome,
  type PanelState,
  type PanelStream,
} from './panelRun';
import { useLogPanelRun } from './useLogPanelRun';
import { useQueryLanguage } from './useQueryLanguage';
import { panelVars, referencedVariables } from './variableRefs';

export interface PanelRunInput {
  readonly tenant: string;
  readonly panel: PanelSpec;
  /** The text to run: the saved text, or the dialog's run text for the edited panel (§4.4). */
  readonly text: string;
  /** In the viewport, full screen open, or the preview. */
  readonly enabled: boolean;
  /** The board panel body's width (§3.4). */
  readonly widthPx: number | null;
  /** Runs of the same text (the editor's Run, plan #67 §3.3): a new LogQL pager each; default 0. */
  readonly runSeq?: number;
  /** The panel behind its open editor: a LogQL stream panel holds no pager (the preview has one). */
  readonly editing?: boolean;
  /**
   * The edited panel's Query field failed to load an import (#147): runs as `runKind`'s degraded
   * (without a language, the range route). Default false. The LogQL run ignores it.
   */
  readonly degraded?: boolean;
}

export type { PanelOutcome };

export interface PanelRun {
  /** The text this run is for (`diagnostics` index into it). */
  readonly text: string;
  readonly blocked: PanelState | null;
  /** The client hint, or the server's `variable.missing` names (§4.2). */
  readonly missing: readonly string[];
  /** `queryTooLarge` (the pre-check) or `tooLong` (the server's 413). */
  readonly refusal: Refusal | null;
  /** The language and width are known and nothing blocks the run. */
  readonly ready: boolean;
  /** The key's data, or the placeholder (§4.3). */
  readonly outcome: PanelOutcome | null;
  /** Null for none, for an `AbortError`, and for a missing variable or a 413. */
  readonly error: unknown;
  /** Indices into `text`; [] unless `queryInvalid`. */
  readonly diagnostics: readonly Diagnostic[];
  readonly fetching: boolean;
  readonly stepMs: number | null;
  /** `planned.expanded` of the current key's own response only (§3.5); else null. */
  readonly expanded: string | null;
  /** The LogQL stream path's pager and controls (plan #67); else null. */
  readonly stream: PanelStream | null;
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);
const NO_NAMES: readonly string[] = Object.freeze([]);

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** The `variable.missing` names of a 400, in field order; null for any other error. */
export function missingOf(e: unknown): string[] | null {
  if (!isApiError(e, 'invalid') || e.fields.length === 0) return null;
  if (!e.fields.every((f) => f.messageKey === 'variable.missing')) return null;
  return e.fields.map((f) => f.pointer.replace(/^\/vars\//, ''));
}

/** The panel's run: its language's hook (plan #67 §3.3). */
export function usePanelRun(a: PanelRunInput): PanelRun {
  const logql = a.panel.query.lang === 'logql';
  const prom = usePromPanelRun(a, !logql);
  const logs = useLogPanelRun(a, logql);
  return logql ? logs : prom;
}

/** A PromQL panel's run; inactive (a LogQL panel), an idle key and no language. */
function usePromPanelRun(a: PanelRunInput, active: boolean): PanelRun {
  const api = useApi();
  const { vars, timeReady } = useContext(BoardRunContext);
  const { window } = useTimeContext();
  const { tenant, panel, text, enabled, widthPx } = a;
  const { fromMs, toMs } = window;
  const { lang, failed } = useQueryLanguage(active ? 'promql' : null);
  const degraded = a.degraded ?? false;

  const hint = useMemo(() => referencedVariables(text).filter((n) => !vars.has(n)), [text, vars]);
  const refusedEarly = useMemo(() => refusalOf(text), [text]);
  const pre: PanelState | null = !active
    ? null
    : panel.vis.kind === 'logs'
      ? 'logs'
      : text.trim() === ''
        ? 'empty'
        : refusedEarly !== null
          ? 'refused'
          : hint.length > 0
            ? 'variable'
            : failed && !degraded
              ? 'langFailed'
              : null;

  // Nothing is planned before the board's time is set (§4.6).
  const stepMs =
    timeReady && widthPx !== null && widthPx > 0
      ? (promGrid(fromMs, toMs, widthPx)?.stepMs ?? null)
      : null;
  const kind = useMemo(
    () => (active && timeReady && pre === null ? runKind(text, lang, degraded) : null),
    [active, timeReady, pre, text, lang, degraded],
  );
  const sentPairs = useMemo(() => panelVars(text, vars), [text, vars]);
  const varsJson = useMemo(() => JSON.stringify(sentPairs), [sentPairs]);
  const runKey = useMemo(
    () =>
      kind !== null && stepMs !== null
        ? panelRunKey(tenant, panel.id, { text, vars: varsJson }, kind, stepMs, { fromMs, toMs })
        : null,
    [kind, stepMs, tenant, panel.id, text, varsJson, fromMs, toMs],
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
    // Fresh within the window epoch only: the provider invalidates (§4.1).
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
      if (kind === null || stepMs === null) throw new Error('panel: a run without its inputs');
      const sent = Object.fromEntries(sentPairs);
      if (kind === 'range') {
        const r = await api.queryRange(
          tenant,
          { query: text, fromMs, toMs, widthPx: widthRef.current ?? 0, vars: sent, rate: true },
          signal,
        );
        return { key: queryKey, planned: r.planned, result: fromRange(r) };
      }
      const r = await api.queryInstant(
        tenant,
        { query: text, atMs: toMs, vars: sent, stepMs },
        signal,
      );
      return { key: queryKey, planned: r.planned, result: fromInstant(r) };
    },
  });

  const rejection = query.isError && !isAbort(query.error) ? query.error : null;
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
  const expanded =
    runKey === null
      ? null
      : query.isError
        ? isApiError(rejection)
          ? (rejection.detail.planned?.expanded ?? null)
          : null
        : outcome !== null && !query.isPlaceholderData && sameKey(outcome.key, runKey)
          ? outcome.planned.expanded
          : null;

  const fetching = query.isFetching;
  return useMemo(
    () => ({
      text,
      blocked,
      missing,
      refusal,
      ready: runKey !== null && blocked === null,
      outcome,
      error,
      diagnostics,
      fetching,
      stepMs,
      expanded,
      stream: null,
    }),
    [
      text,
      blocked,
      missing,
      refusal,
      runKey,
      outcome,
      error,
      diagnostics,
      fetching,
      stepMs,
      expanded,
    ],
  );
}
