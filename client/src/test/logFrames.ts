/**
 * Log page fixtures (plan #66 Part B §2): a `LogFrame` from plain rows, and a `kind: 'streams'`
 * answer around it.
 */
import type { LogsResult } from '../data/decode';
import { LOG_LEVELS, type LogFrame, type LogLevel, type LogStreamInfo } from '../data/logFrame';
import { keyHash } from '../dev/keyHash';

export interface FrameRow {
  readonly ts: bigint;
  readonly level: LogLevel;
  readonly line: string;
  /** Index into the frame's streams (default 0). */
  readonly stream?: number;
}

export interface FrameOptions {
  readonly direction?: 'backward' | 'forward';
  /** The stream labels, by index (default one stream `{app: 'x'}`). */
  readonly streams?: readonly Readonly<Record<string, string>>[];
}

export function streamInfo(labels: Readonly<Record<string, string>>): LogStreamInfo {
  return { key: keyHash(labels), labels };
}

export function logFrame(rows: readonly FrameRow[], o: FrameOptions = {}): LogFrame {
  const streams = (o.streams ?? [{ app: 'x' }]).map(streamInfo);
  return {
    direction: o.direction ?? 'backward',
    streams,
    tsNs: BigInt64Array.from(rows.map((r) => r.ts)),
    streamIndex: Uint32Array.from(rows.map((r) => r.stream ?? 0)),
    lines: rows.map((r) => r.line),
    levels: Uint8Array.from(rows.map((r) => LOG_LEVELS.indexOf(r.level))),
    metadata: rows.map(() => null),
    parsed: rows.map(() => null),
  };
}

export interface ResultOptions {
  readonly truncated?: boolean;
  readonly warnings?: readonly string[];
  readonly infos?: readonly string[];
  readonly queryId?: string | null;
  readonly fromMs?: number;
  readonly toMs?: number;
}

/** A `kind: 'streams'` answer of `frame` with `cursor`. */
export function streamsResult(
  frame: LogFrame,
  cursor: string | null,
  o: ResultOptions = {},
): Extract<LogsResult, { kind: 'streams' }> {
  return {
    kind: 'streams',
    fromMs: o.fromMs ?? 1767225600000,
    toMs: o.toMs ?? 1767229200000,
    stepMs: 1000,
    frame,
    cursor,
    completeness: {
      truncated: o.truncated ?? false,
      warnings: o.warnings ?? [],
      infos: o.infos ?? [],
      queryId: o.queryId ?? null,
      dataAgeMs: null,
      readCache: null,
      readCacheThroughMs: null,
    },
    planned: { query: '{app="x"}', expanded: '{app="x"}', bytes: 9, stepMs: 1000 },
  };
}

/** A `kind: 'series'` answer (a LogQL metric query). */
export function seriesResult(): Extract<LogsResult, { kind: 'series' }> {
  return {
    kind: 'series',
    startMs: 1767225600000,
    endMs: 1767229200000,
    stepMs: 1000,
    series: [],
    completeness: {
      truncated: false,
      warnings: [],
      infos: [],
      queryId: null,
      dataAgeMs: null,
      readCache: null,
      readCacheThroughMs: null,
    },
    planned: {
      query: 'rate({app="x"}[1m])',
      expanded: 'rate({app="x"}[1m])',
      bytes: 19,
      stepMs: 1000,
    },
  };
}

/** `n` rows of page `k`: ts `1767229200000000000n − i`, lines `p<k>r<i>`, level info. */
export function pageRows(k: number, n: number, line?: (i: number) => string): FrameRow[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1767229200000000000n - BigInt(i),
    level: 'info' as const,
    line: line === undefined ? `p${String(k)}r${String(i)}` : line(i),
  }));
}
