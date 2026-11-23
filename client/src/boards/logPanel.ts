/**
 * The pure parts of a board LogQL panel (plan #67 §3.2). Stubs until the implementation lands.
 */
import type { Api } from '../api/Api';
import type { PanelVisKind, PlannedQuery } from '../api/types';
import type { Completeness, LogqlPlannedQuery } from '../data/decode';
import type { LogPagerInput, LogPagerState } from '../logs/logPager';
import type { PanelOutcome } from './panelRun';

export const PANEL_PREFETCH_ROWS = 50;

export type LogPanelPath = 'stream' | 'logs-bars' | 'logs-frame';

export function logPanelPath(_kind: PanelVisKind): LogPanelPath {
  throw new Error('logPanelPath: not implemented');
}

export interface StreamRun {
  readonly input: LogPagerInput;
  readonly generation: string;
}

export function streamInput(
  _enabled: boolean,
  _held: StreamRun | null,
  _next: StreamRun | null,
): StreamRun | null {
  throw new Error('streamInput: not implemented');
}

export function fromLogqlPlanned(_p: LogqlPlannedQuery): PlannedQuery {
  throw new Error('fromLogqlPlanned: not implemented');
}

export function streamMeta(_s: LogPagerState | null): {
  planned: LogqlPlannedQuery | null;
  completeness: Completeness | null;
} {
  throw new Error('streamMeta: not implemented');
}

export interface LogFrameRequest {
  readonly query: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly widthPx: number;
  readonly vars: Readonly<Record<string, string>>;
}

export function fetchLogFrame(
  _api: Pick<Api, 'queryLogs' | 'queryVolume'>,
  _tenant: string,
  _req: LogFrameRequest,
  _withVolume: boolean,
  _signal: AbortSignal,
): Promise<Omit<PanelOutcome, 'key'>> {
  return Promise.reject(new Error('fetchLogFrame: not implemented'));
}
