/** The client pager over `Api.queryLogs` (plan #66 Part B §3.3). Stub: implemented in the next commit. */
import type { Api } from '../api/Api';
import type { Completeness, LogqlPlannedQuery, LogsResult } from '../data/decode';
import { LogBuffer, type BufferCaps, type OrdRange } from './logBuffer';

export const PAGE_LIMIT = 1000;

export interface LogPagerInput {
  readonly tenant: string;
  readonly query: string;
  readonly vars?: Readonly<Record<string, string>>;
  readonly fromMs: number;
  readonly toMs: number;
  readonly widthPx: number;
  readonly direction: 'backward' | 'forward';
  readonly limit?: number;
  readonly timeoutMs?: number;
}

export type EndStatus = 'idle' | 'loading' | 'error' | 'drift';
export interface EndState {
  readonly status: EndStatus;
  readonly error: unknown;
}

export interface LogPagerState {
  readonly version: number;
  readonly phase: 'pending' | 'streams' | 'series' | 'failed';
  readonly series: Extract<LogsResult, { kind: 'series' }> | null;
  readonly planned: LogqlPlannedQuery | null;
  readonly completeness: Completeness | null;
  readonly head: EndState;
  readonly tail: EndState;
  readonly firstOrd: number;
  readonly endOrd: number;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly total: number | null;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export class LogPager {
  readonly input: LogPagerInput;
  readonly buffer: LogBuffer;
  constructor(api: Pick<Api, 'queryLogs'>, input: LogPagerInput, caps?: BufferCaps) {
    void api;
    this.input = input;
    this.buffer = new LogBuffer(caps);
    notImplemented();
  }
  getState(): LogPagerState {
    return notImplemented();
  }
  subscribe(listener: () => void): () => void {
    void listener;
    return notImplemented();
  }
  start(): Promise<void> {
    return notImplemented();
  }
  loadTail(): Promise<void> {
    return notImplemented();
  }
  loadHead(): Promise<void> {
    return notImplemented();
  }
  retry(end: 'head' | 'tail'): Promise<void> {
    void end;
    return notImplemented();
  }
  protect(range: OrdRange | null): void {
    void range;
    notImplemented();
  }
  dispose(): void {
    notImplemented();
  }
}

export function logPagerKey(input: LogPagerInput): string {
  void input;
  return notImplemented();
}
