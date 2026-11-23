/**
 * The synthetic log API (plan #66 Part B, B.1; development, stub builds and tests only): answers
 * `queryLogs` exactly as the BFF's pager (`server/internal/pulsusdb/logpage.go`: `stepB`, `stepA`,
 * `past`) delivers the same data for the same `limit` and direction, without JSON. Whole
 * timestamp groups per page; a group larger than the limit is continued by a `(ts, skip)` cursor;
 * past the group the cursor moves one nanosecond on. The shared fixture
 * `wire/fixtures/json/logql-paging.json` checks this module and the Go pager alike.
 */
import type { Api } from '../api/Api';
import type { LogsRequest } from '../api/types';
import type { Completeness, LogsResult } from '../data/decode';
import type { LogFrame, LogStreamInfo } from '../data/logFrame';
import { canonicalLabels, keyHash } from './keyHash';

export interface SynthEntry {
  readonly tsNs: bigint;
  readonly labels: Readonly<Record<string, string>>;
  readonly line: string;
}

export interface SynthLogOptions {
  /** Explicit data (fixtures, mutations); else generated: `total` entries, groups 1 ms apart from `to` back. */
  readonly entries?: readonly SynthEntry[];
  readonly total?: number;
  /** Generated: size (≥ 1) of group g, default () => 1. */
  readonly groupOf?: (g: number) => number;
  /** Generated: `synth line <i> ` padded with `x` to this many characters (default 100). */
  readonly lineLength?: number;
  readonly latencyMs?: number;
}

export interface SynthLogApi extends Pick<Api, 'queryLogs'> {
  latencyMs: number;
  readonly calls: readonly LogsRequest[];
  /** Explicit data only: from now on the data has `e` too / has `withLine` instead of `line` at `tsNs`. */
  insert(e: SynthEntry): void;
  replace(tsNs: bigint, line: string, withLine: string): void;
}

interface Cursor {
  readonly tsNs: bigint;
  readonly skip: number;
}

/** `s:<tsNs>:<skip>`. */
export function synthCursor(c: Cursor): string {
  return `s:${c.tsNs.toString()}:${String(c.skip)}`;
}

export function parseSynthCursor(c: string): Cursor {
  const m = /^s:(\d+):(\d+)$/.exec(c);
  if (m === null) throw new Error(`not a synth cursor: ${c}`);
  return { tsNs: BigInt(m[1] ?? '0'), skip: Number(m[2]) };
}

/** One entry in a page: its stream and the level code. */
interface Row {
  readonly tsNs: bigint;
  readonly stream: LogStreamInfo;
  readonly line: string;
  readonly level: number;
}

/** The data as timestamp groups, in group order within each group. */
interface Source {
  /** Groups of (lo, hi] in direction order, starting at the first group whose ts ≤ T (backward)
   *  or ≥ T (forward); all groups when `from` is null. */
  groupsFrom(lo: bigint, hi: bigint, dir: Dir, from: bigint | null): Iterable<readonly Row[]>;
  /** The group at exactly `ts` inside (lo, hi], group order; empty when there is none. */
  groupAt(lo: bigint, hi: bigint, ts: bigint): readonly Row[];
}

type Dir = 'backward' | 'forward';

const NS_PER_MS = 1_000_000n;

const EMPTY_COMPLETENESS: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};

/** Group order: stream key ascending, then line (UTF-16 order). */
function groupOrder(a: Row, b: Row): number {
  if (a.stream.key !== b.stream.key) return a.stream.key < b.stream.key ? -1 : 1;
  if (a.line !== b.line) return a.line < b.line ? -1 : 1;
  return 0;
}

function streamCache(): (labels: Readonly<Record<string, string>>) => LogStreamInfo {
  const cache = new Map<string, LogStreamInfo>();
  return (labels) => {
    const c = canonicalLabels(labels);
    let s = cache.get(c);
    if (s === undefined) {
      s = { key: keyHash(labels), labels: { ...labels } };
      cache.set(c, s);
    }
    return s;
  };
}

function explicitSource(entries: SynthEntry[]): Source {
  const streamOf = streamCache();
  const groups = (lo: bigint, hi: bigint): Map<bigint, Row[]> => {
    const by = new Map<bigint, Row[]>();
    for (const e of entries) {
      if (e.tsNs <= lo || e.tsNs > hi) continue;
      const row: Row = { tsNs: e.tsNs, stream: streamOf(e.labels), line: e.line, level: 0 };
      const g = by.get(e.tsNs);
      if (g === undefined) by.set(e.tsNs, [row]);
      else g.push(row);
    }
    for (const g of by.values()) g.sort(groupOrder);
    return by;
  };
  return {
    *groupsFrom(lo, hi, dir, from) {
      const by = groups(lo, hi);
      const ts = [...by.keys()].sort((a, b) =>
        dir === 'backward' ? (a > b ? -1 : a < b ? 1 : 0) : a < b ? -1 : a > b ? 1 : 0,
      );
      for (const t of ts) {
        if (from !== null && (dir === 'backward' ? t > from : t < from)) continue;
        yield by.get(t) ?? [];
      }
    },
    groupAt(lo, hi, ts) {
      return groups(lo, hi).get(ts) ?? [];
    },
  };
}

function generatedSource(
  total: number,
  groupOf: (g: number) => number,
  lineLength: number,
): Source {
  // starts[g]: the backward index of group g's first entry; the last element is ≥ total.
  const starts: number[] = [0];
  while ((starts.at(-1) ?? 0) < total) {
    starts.push((starts.at(-1) ?? 0) + Math.max(1, Math.floor(groupOf(starts.length - 1))));
  }
  const groupCount = starts.length - 1;
  const streams = [0, 1, 2].map((p) => {
    const labels = { service_name: 'synth', pod: `synth-${String(p)}` };
    return { key: keyHash(labels), labels };
  });
  const rows = (g: number, ts: bigint): Row[] => {
    const out: Row[] = [];
    const end = Math.min(starts[g + 1] ?? total, total);
    for (let i = starts[g] ?? 0; i < end; i += 1) {
      const stream = streams[i % 3];
      if (stream === undefined) continue;
      out.push({
        tsNs: ts,
        stream,
        line: `synth line ${String(i)} `.padEnd(lineLength, 'x'),
        level: i % 7,
      });
    }
    return out.sort(groupOrder);
  };
  // Group g is at hi − g ms; it exists while g < groupCount and its ts is above lo.
  const inWindow = (g: number, lo: bigint, hi: bigint): boolean =>
    g >= 0 && g < groupCount && hi - BigInt(g) * NS_PER_MS > lo;
  return {
    *groupsFrom(lo, hi, dir, from) {
      if (dir === 'backward') {
        // The first group with ts ≤ from: g ≥ (hi − from) / 1 ms.
        let g = 0;
        if (from !== null) {
          const d = hi - from;
          g = d <= 0n ? 0 : Number((d + NS_PER_MS - 1n) / NS_PER_MS);
        }
        for (; inWindow(g, lo, hi); g += 1) yield rows(g, hi - BigInt(g) * NS_PER_MS);
      } else {
        // Oldest first: the last group in the window, or the first with ts ≥ from.
        let g = groupCount - 1;
        while (g >= 0 && !inWindow(g, lo, hi)) g -= 1;
        if (from !== null) {
          const d = hi - from;
          if (d < 0n) return;
          g = Math.min(g, Number(d / NS_PER_MS));
        }
        for (; g >= 0; g -= 1) yield rows(g, hi - BigInt(g) * NS_PER_MS);
      }
    },
    groupAt(lo, hi, ts) {
      const d = hi - ts;
      if (d < 0n || d % NS_PER_MS !== 0n) return [];
      const g = Number(d / NS_PER_MS);
      return inWindow(g, lo, hi) ? rows(g, ts) : [];
    },
  };
}

/** The page's frame: streams by key, rows in page order. */
function frameOf(rows: readonly Row[], dir: Dir): LogFrame {
  const streams = [...new Map(rows.map((r) => [r.stream.key, r.stream])).values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const index = new Map(streams.map((s, i) => [s.key, i]));
  return {
    direction: dir,
    streams,
    tsNs: BigInt64Array.from(rows, (r) => r.tsNs),
    streamIndex: Uint32Array.from(rows, (r) => index.get(r.stream.key) ?? 0),
    lines: rows.map((r) => r.line),
    levels: Uint8Array.from(rows, (r) => r.level),
    metadata: rows.map(() => null),
    parsed: rows.map(() => null),
  };
}

/** One page of `src` for the request: B.1's rules. */
function pageOf(
  src: Source,
  lo: bigint,
  hi: bigint,
  dir: Dir,
  limit: number,
  cursor: Cursor | null,
): { rows: Row[]; next: Cursor | null } {
  const past = (t: bigint): Cursor | null => {
    if (dir === 'backward') return t - 1n > lo ? { tsNs: t - 1n, skip: 0 } : null;
    return t < hi ? { tsNs: t + 1n, skip: 0 } : null;
  };
  if (cursor !== null && cursor.skip > 0) {
    const g = src.groupAt(lo, hi, cursor.tsNs);
    if (g.length <= cursor.skip) return { rows: [], next: past(cursor.tsNs) };
    const rows = g.slice(cursor.skip, cursor.skip + limit);
    const done = cursor.skip + rows.length;
    return {
      rows,
      next: done < g.length ? { tsNs: cursor.tsNs, skip: done } : past(cursor.tsNs),
    };
  }
  const rows: Row[] = [];
  for (const g of src.groupsFrom(lo, hi, dir, cursor === null ? null : cursor.tsNs)) {
    const first = g[0];
    if (first === undefined) continue;
    if (rows.length + g.length <= limit) {
      rows.push(...g);
      continue;
    }
    if (rows.length > 0) return { rows, next: { tsNs: first.tsNs, skip: 0 } };
    return { rows: g.slice(0, limit), next: { tsNs: first.tsNs, skip: limit } };
  }
  return { rows, next: null };
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal?.aborted === true) {
      aborted();
      return;
    }
    if (ms <= 0) {
      queueMicrotask(() => {
        if (signal?.aborted === true) aborted();
        else resolve();
      });
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      aborted();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createSynthLogApi(o: SynthLogOptions): SynthLogApi {
  const data = o.entries === undefined ? null : [...o.entries];
  const src =
    data === null
      ? generatedSource(o.total ?? 0, o.groupOf ?? (() => 1), o.lineLength ?? 100)
      : explicitSource(data);
  const calls: LogsRequest[] = [];
  const api: SynthLogApi = {
    latencyMs: o.latencyMs ?? 0,
    calls,
    async queryLogs(_tenant, req, signal): Promise<LogsResult> {
      calls.push(req);
      await delay(api.latencyMs, signal);
      const dir: Dir = req.direction ?? 'backward';
      const lo = BigInt(req.fromMs) * NS_PER_MS;
      const hi = BigInt(req.toMs) * NS_PER_MS;
      const cursor = req.cursor === undefined ? null : parseSynthCursor(req.cursor);
      const { rows, next } = pageOf(src, lo, hi, dir, req.limit ?? 1000, cursor);
      return {
        kind: 'streams',
        fromMs: req.fromMs,
        toMs: req.toMs,
        stepMs: 1000,
        frame: frameOf(rows, dir),
        cursor: next === null ? null : synthCursor(next),
        completeness: EMPTY_COMPLETENESS,
        planned: {
          query: req.query,
          expanded: req.query,
          bytes: new TextEncoder().encode(req.query).length,
          stepMs: 1000,
        },
      };
    },
    insert(e) {
      if (data === null) throw new Error('insert: generated data');
      data.push(e);
    },
    replace(tsNs, line, withLine) {
      if (data === null) throw new Error('replace: generated data');
      for (const [i, e] of data.entries()) {
        if (e.tsNs === tsNs && e.line === line) data[i] = { ...e, line: withLine };
      }
    },
  };
  return api;
}
