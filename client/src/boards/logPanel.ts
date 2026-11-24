/**
 * The pure parts of a board LogQL panel (plan #67 §3.2). The saved vis picks the path: Auto and
 * Logs page the lines through a `LogPager` (the stream path), the others draw one frame from a
 * kind probe (`limit: 1`) and, for Bars, the log volume, fetched in parallel under the panel key.
 * The answer's kind decides what is drawn (ADR-0021 §2: nothing is planned in the browser).
 */
import type { Api } from '../api/Api';
import type { PanelVisKind, PlannedQuery } from '../api/types';
import type { Completeness, LogqlPlannedQuery, LogsResult, VolumeResult } from '../data/decode';
import { logPagerKey, type LogPagerInput, type LogPagerState } from '../logs/logPager';
import { fromRange } from '../vis/autovis';
import type { PanelOutcome } from './panelRun';

/** A panel's `LogStream` loads the next page this many rows from either end (SRF-036). */
export const PANEL_PREFETCH_ROWS = 50;

export type LogPanelPath = 'stream' | 'logs-bars' | 'logs-frame';

/** auto, logs → stream; bars → logs-bars; line, heatmap, stat → logs-frame. */
export function logPanelPath(kind: PanelVisKind): LogPanelPath {
  switch (kind) {
    case 'auto':
    case 'logs':
      return 'stream';
    case 'bars':
      return 'logs-bars';
    case 'line':
    case 'heatmap':
    case 'stat':
      return 'logs-frame';
  }
}

/** A stream panel's pager input and its generation (`refreshEpoch.runSeq.driftSeq`). */
export interface StreamRun {
  readonly input: LogPagerInput;
  readonly generation: string;
}

/**
 * The run a stream panel holds (T07-012): `enabled` → `next`; else `next` when `held` has its
 * `logPagerKey` and generation (scrolled out, nothing changed: the pager is kept); else null.
 */
export function streamInput(
  enabled: boolean,
  held: StreamRun | null,
  next: StreamRun | null,
): StreamRun | null {
  if (enabled) return next;
  if (held === null || next === null) return null;
  return held.generation === next.generation && logPagerKey(held.input) === logPagerKey(next.input)
    ? next
    : null;
}

/** A LogQL `planned` as a panel's: the server's facts, no PromQL rate or histogram facts. */
export function fromLogqlPlanned(p: LogqlPlannedQuery): PlannedQuery {
  return {
    query: p.query,
    expanded: p.expanded,
    bytes: p.bytes,
    stepMs: p.stepMs,
    valueType: 'unknown',
    rateCandidate: false,
    rateApplied: false,
    histogram: false,
  };
}

/** streams → state.planned, state.completeness; series → the series'; else nulls. */
export function streamMeta(s: LogPagerState | null): {
  planned: LogqlPlannedQuery | null;
  completeness: Completeness | null;
} {
  if (s?.phase === 'streams') return { planned: s.planned, completeness: s.completeness };
  if (s?.phase === 'series' && s.series !== null) {
    return { planned: s.series.planned, completeness: s.series.completeness };
  }
  return { planned: null, completeness: null };
}

export interface LogFrameRequest {
  readonly query: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly widthPx: number;
  readonly vars: Readonly<Record<string, string>>;
}

/**
 * A frame panel's fetch (§3.2): with `withVolume` the volume starts at once, beside the kind
 * probe. A metric answer aborts the volume and is drawn as its series; a log answer is the volume
 * (Bars) or an empty series result (the view says the vis needs a metric query). One inner
 * controller follows `signal`, so a new key or no observer aborts both requests; the listener is
 * removed when the fetch settles. Cancel-safe: an abort rejects with the request's `AbortError`.
 */
export async function fetchLogFrame(
  api: Pick<Api, 'queryLogs' | 'queryVolume'>,
  tenant: string,
  req: LogFrameRequest,
  withVolume: boolean,
  signal: AbortSignal,
): Promise<Omit<PanelOutcome, 'key'>> {
  const inner = new AbortController();
  const onAbort = (): void => {
    inner.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let vol: Promise<VolumeResult> | null = null;
    if (withVolume) {
      vol = api.queryVolume(tenant, req, inner.signal);
      // Awaited below or abandoned (a metric answer, a rejected probe): never unhandled.
      vol.catch(() => undefined);
    }
    let p: LogsResult;
    try {
      p = await api.queryLogs(tenant, { ...req, limit: 1 }, inner.signal);
    } catch (e) {
      inner.abort();
      throw e;
    }
    const planned = fromLogqlPlanned(p.planned);
    if (p.kind === 'series') {
      inner.abort();
      return { planned, result: fromRange(p), logKind: 'series' };
    }
    if (vol === null) {
      return {
        planned,
        result: {
          kind: 'series',
          source: 'range',
          series: [],
          stepMs: p.stepMs,
          completeness: p.completeness,
        },
        logKind: 'streams',
      };
    }
    const v = await vol;
    return { planned, result: fromRange(v), logKind: 'streams', volume: v };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
