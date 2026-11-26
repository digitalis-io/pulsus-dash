/**
 * Shared setup of the board LogQL panel tests (plan #67 §5.2): the board on a `StubApi` whose
 * `queryLogs` and `queryVolume` record each call and return a deferred the test settles
 * (`queryRange` and `queryInstant` are spied as `openBoard`'s), the log stream's jsdom layout, the
 * LogQL panel specs and the fixtures. The test file mocks the editor chunks itself
 * (`fakeEditor.tsx`, `fakeLogqlEditor.tsx`).
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import type {
  DataPanelSpec,
  DataVisKind,
  LogsRequest,
  PanelSpec,
  VolumeRequest,
} from '../api/types';
import type { LogqlPlannedQuery, LogsResult, VolumeResult } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { keyHash } from '../dev/keyHash';
import { ABS, T12, T13 } from './boardPanelKit';
import { boardWith, engineWrapper } from './boardTestKit';
import { fakeEngine } from './fakeEngine';
import { installLayout } from './fakeLayout';
import { EMPTY_COMPLETENESS } from './histogramFixtures';
import { logFrame, pageRows, seriesResult, streamsResult } from './logFrames';
import { renderApp } from './renderApp';

export { EMPTY_COMPLETENESS };

/** One recorded call: settle it with `resolve` or `reject` (each waits for the handlers). */
export interface Call<R, T> {
  readonly tenant: string;
  readonly req: R;
  readonly signal: AbortSignal | undefined;
  resolve(v: T): Promise<void>;
  reject(e: unknown): Promise<void>;
}

function record<R, T>(
  calls: Call<R, T>[],
  tenant: string,
  req: R,
  signal: AbortSignal | undefined,
): Promise<T> {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    res = a;
    rej = b;
  });
  const settled = (): Promise<void> =>
    act(async () => {
      await promise.then(
        () => undefined,
        () => undefined,
      );
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });
  calls.push({
    tenant,
    req,
    signal,
    resolve: (v) => {
      res(v);
      return settled();
    },
    reject: (e) => {
      rej(e);
      return settled();
    },
  });
  return promise;
}

/** A LogQL panel; `grid` defaults to a 6 × 8 cell placed by the id's number. */
export function logPanel(
  id: string,
  title: string,
  text: string,
  kind: DataVisKind = 'auto',
): DataPanelSpec {
  const n = Math.max(1, Number(/\d+$/.exec(id)?.[0] ?? '1'));
  const [x, y] = [6 * ((n - 1) % 2), 8 * Math.floor((n - 1) / 2)];
  return { id, title, grid: { x, y, w: 6, h: 8 }, query: { lang: 'logql', text }, vis: { kind } };
}

export interface LogBoardOpts {
  readonly search?: string;
  readonly extra?: string;
  readonly url?: string;
  /** Another render of a board already in this api (a reload). */
  readonly api?: StubApi;
}

/** The board `b-1` of `panels`, its LogQL calls held by the test. */
export function openLogBoard(panels: readonly PanelSpec[], o: LogBoardOpts = {}) {
  const api = o.api ?? new StubApi(boardWith(panels));
  const logs: Call<LogsRequest, LogsResult>[] = [];
  const volume: Call<VolumeRequest, VolumeResult>[] = [];
  const queryLogs = vi.fn((tenant: string, req: LogsRequest, signal?: AbortSignal) =>
    record(logs, tenant, req, signal),
  );
  const queryVolume = vi.fn((tenant: string, req: VolumeRequest, signal?: AbortSignal) =>
    record(volume, tenant, req, signal),
  );
  api.queryLogs = queryLogs;
  api.queryVolume = queryVolume;
  const range = vi.spyOn(api, 'queryRange');
  const instant = vi.spyOn(api, 'queryInstant');
  const engine = fakeEngine();
  const url = o.url ?? `/t/demo/board/b-1?${o.search ?? ABS}${o.extra ?? ''}`;
  const r = renderApp(url, { api, wrapper: engineWrapper(engine) });
  /** The stream pages (every call but a probe). */
  const pages = () => logs.filter((c) => c.req.limit !== 1);
  const probes = () => logs.filter((c) => c.req.limit === 1);
  return { ...r, api, range, instant, engine, logs, volume, queryLogs, queryVolume, pages, probes };
}
export type LogBoard = ReturnType<typeof openLogBoard>;

/** Installs the log stream's jsdom layout (a panel body of 1000 × 240); returns the restore. */
export function installLogLayout(): () => void {
  return installLayout({ width: 1000, height: 240 });
}

export const planned = (q: string): LogqlPlannedQuery => ({
  query: q,
  expanded: q,
  bytes: q.length,
  stepMs: 5000,
});

/** A stream answer of `n` lines `p0r<i>`, with `cursor`. */
export function lines(
  n: number,
  o: { cursor?: string | null; truncated?: boolean; q?: string } = {},
): Extract<LogsResult, { kind: 'streams' }> {
  const r = streamsResult(logFrame(pageRows(0, n)), o.cursor ?? null, {
    truncated: o.truncated ?? false,
    fromMs: T12,
    toMs: T13,
  });
  return { ...r, stepMs: 5000, planned: planned(o.q ?? '{app="a"}') };
}

/** A series of one sample, keyed as the decoder keys it. */
export const level = (l: string, v: number): SeriesFrame => ({
  key: keyHash({ level: l }),
  labels: { level: l },
  timestamps: Float64Array.of(T12 + 5000),
  values: Float64Array.of(v),
});

/** A metric answer of one series per key. */
export function metric(
  keys: readonly string[] = ['a'],
  o: { truncated?: boolean; q?: string } = {},
): Extract<LogsResult, { kind: 'series' }> {
  const s = seriesResult();
  return {
    ...s,
    startMs: T12,
    endMs: T13,
    stepMs: 5000,
    series: keys.map((k, i) => ({
      ...level(k, i + 1),
      key: keyHash({ app: k }),
      labels: { app: k },
    })),
    completeness: { ...s.completeness, truncated: o.truncated ?? false },
    planned: planned(o.q ?? 'rate({app="a"}[1m])'),
  };
}

/** A volume answer of the levels `error` and `info`. */
export function vol(q = '{app="a"}'): VolumeResult {
  return {
    startMs: T12,
    endMs: T13,
    stepMs: 5000,
    series: [level('error', 3), level('info', 5)],
    completeness: EMPTY_COMPLETENESS,
    planned: planned(q),
  };
}

export const aborted = (c: { signal: AbortSignal | undefined } | undefined): boolean =>
  c?.signal?.aborted === true;
