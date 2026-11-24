/**
 * Shared setup of the Explore › Logs page tests (plan #66 Part C §5.2): the app with a fake chart
 * engine, the log stream's jsdom layout and a frozen clock; a `StubApi` whose `queryLogs` and
 * `queryVolume` record each call and return a deferred the test settles; the fixtures and small
 * readers of the page. The test file mocks the editor chunk with `fakeLogqlEditor.tsx`.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { expect } from 'vitest';
import type { ReactNode } from 'react';
import { StubApi } from '../api/StubApi';
import type { LogsRequest, VolumeRequest } from '../api/types';
import type { Completeness, LogsResult, VolumeResult } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import type { LogLevel } from '../data/logFrame';
import { ChartEngineContext } from '../engine/index';
import type { Clock } from '../state/clock';
import { ABS, HOUR, W0 } from './exploreTestKit';
import { fakeEngine } from './fakeEngine';
import { installLayout } from './fakeLayout';
import { resizeOf } from './fakeResizeObserver';
import { EMPTY_COMPLETENESS, fkey } from './histogramFixtures';
import { logFrame, type FrameRow } from './logFrames';
import { renderApp } from './renderApp';

export { ABS, HOUR, W0, EMPTY_COMPLETENESS };

/** The results column width of the tests: step 5 s on the 1 h window of ABS. */
export const COLUMN_PX = 960;

/** `/t/<tenant>/explore/logs?ABS[&q=…]<extra>`. */
export function logsUrl(q?: string, extra = '', tenant = 'demo', abs = ABS): string {
  const qs = q === undefined ? '' : `&q=${encodeURIComponent(q)}`;
  return `/t/${tenant}/explore/logs?${abs}${qs}${extra}`;
}

/** One recorded call: settle it with `resolve` or `reject` (each waits for the handlers). */
export interface Deferred<R, T> {
  readonly tenant: string;
  readonly req: R;
  readonly signal: AbortSignal | undefined;
  resolve(v: T): Promise<void>;
  reject(e: unknown): Promise<void>;
}

export interface ScriptedLogsPageApi {
  readonly api: StubApi;
  readonly logs: Deferred<LogsRequest, LogsResult>[];
  readonly volume: Deferred<VolumeRequest, VolumeResult>[];
}

function deferredCall<R, T>(
  calls: Deferred<R, T>[],
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
  // Settling resolves after the handlers have run (microtasks, then a macrotask), inside act.
  const settled = (): Promise<void> =>
    act(async () => {
      await promise.then(
        () => undefined,
        () => undefined,
      );
      await new Promise((r) => setTimeout(r, 0));
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

/** A `StubApi` whose `queryLogs` and `queryVolume` never settle on their own (an abort does not). */
export function scriptedLogsPageApi(): ScriptedLogsPageApi {
  const api = new StubApi();
  const logs: Deferred<LogsRequest, LogsResult>[] = [];
  const volume: Deferred<VolumeRequest, VolumeResult>[] = [];
  api.queryLogs = (tenant, req, signal) => deferredCall(logs, tenant, req, signal);
  api.queryVolume = (tenant, req, signal) => deferredCall(volume, tenant, req, signal);
  return { api, logs, volume };
}

/** Installs the log stream's jsdom layout (`fakeLayout`); returns the restore function. */
export function installLogsLayout(): () => void {
  return installLayout({ width: COLUMN_PX, height: 560 });
}

export function openLogs(
  u: string,
  o: { api?: StubApi; queryClient?: QueryClient; now?: () => number; clock?: Clock } = {},
) {
  const engine = fakeEngine();
  const api = o.api ?? new StubApi();
  function Wrapper({ children }: { children: ReactNode }) {
    return <ChartEngineContext.Provider value={engine}>{children}</ChartEngineContext.Provider>;
  }
  const r = renderApp(u, {
    api,
    wrapper: Wrapper,
    ...(o.queryClient === undefined ? {} : { queryClient: o.queryClient }),
    ...(o.now === undefined ? {} : { now: o.now }),
    ...(o.clock === undefined ? {} : { clock: o.clock }),
  });
  return { ...r, engine, api };
}

export type Engine = ReturnType<typeof openLogs>['engine'];

/** The page's results column (its width is the run's `widthPx`). */
export function resultsColumn(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-logs-results]');
  if (el === null) throw new Error('no results column');
  return el;
}

/** Gives the results column a width (default COLUMN_PX). */
export function resizeColumn(width = COLUMN_PX): void {
  act(() => {
    resizeOf(resultsColumn(), width, 600);
  });
}

/** Waits for the page, then gives the results column its width. */
export async function sized(width = COLUMN_PX): Promise<void> {
  await screen.findByRole('heading', { level: 2, name: 'Query' });
  await waitFor(() => {
    expect(document.querySelector('[data-logs-results]')).not.toBeNull();
  });
  resizeColumn(width);
}

export function runButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Run' });
}

/** `sized()`, then waits for Run to be enabled. */
export async function ready(width = COLUMN_PX): Promise<HTMLElement> {
  await sized(width);
  const run = await screen.findByRole('button', { name: 'Run' });
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  return run;
}

export function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'LogQL query' });
}

export function setDraft(value: string): void {
  fireEvent.input(textbox(), { target: { value } });
}

export function runKey(): void {
  fireEvent.keyDown(textbox(), { key: 'Enter', shiftKey: true });
}

/** Two rounds of the task queue. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise((r) => {
        setTimeout(r, 0);
      });
    });
  }
}

const completeness = (o: Partial<Completeness> = {}): Completeness => ({
  ...EMPTY_COMPLETENESS,
  ...o,
});

/** `n` rows `line <i>`, newest first, one stream `{app: 'a'}`, at level `level(i)`. */
export function rowsOf(
  n: number,
  line: (i: number) => string = (i) => `line ${String(i)}`,
  level: (i: number) => LogLevel = () => 'info',
): FrameRow[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: BigInt(W0 + HOUR) * 1_000_000n - BigInt(i) * 1_000_000_000n,
    level: level(i),
    line: line(i),
  }));
}

/** A `streams` page of `rows` with `cursor`. */
export function page(
  rows: readonly FrameRow[],
  cursor: string | null = null,
  c: Partial<Completeness> = {},
): Extract<LogsResult, { kind: 'streams' }> {
  return {
    kind: 'streams',
    fromMs: W0,
    toMs: W0 + HOUR,
    stepMs: 5000,
    frame: logFrame(rows, { streams: [{ app: 'a' }] }),
    cursor,
    completeness: completeness(c),
    planned: { query: '{app="a"}', expanded: '{app="a"}', bytes: 9, stepMs: 5000 },
  };
}

function seriesFrame(n: number, labels: Record<string, string>, values: number[]): SeriesFrame {
  return {
    key: fkey(n),
    labels,
    timestamps: Float64Array.from(values, (_, i) => W0 + 5000 * i),
    values: Float64Array.from(values),
  };
}

/** A metric answer (`kind: 'series'`) of one series `{level: "error"}` with `values`. */
export function seriesAnswer(
  values: number[] = [1, 2],
  c: Partial<Completeness> = {},
): Extract<LogsResult, { kind: 'series' }> {
  return {
    kind: 'series',
    planned: { query: 'q', expanded: 'q', bytes: 1, stepMs: 5000 },
    startMs: W0,
    endMs: W0 + HOUR,
    stepMs: 5000,
    series: [seriesFrame(1, { level: 'error' }, values)],
    completeness: completeness(c),
  };
}

/** A volume answer: one series per level, on one grid. */
export function volumeAnswer(
  levels: readonly string[] = ['error', 'info'],
  c: Partial<Completeness> = {},
): VolumeResult {
  return {
    planned: { query: 'v', expanded: 'v', bytes: 1, stepMs: 5000 },
    startMs: W0,
    endMs: W0 + HOUR,
    stepMs: 5000,
    series: levels.map((level, i) => seriesFrame(i + 1, { level }, [i + 1, i + 2])),
    completeness: completeness(c),
  };
}

/** The rendered rows of the `Log lines` list. */
export function listItems(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Log lines' });
  if (list === null) return [];
  return [...list.querySelectorAll<HTMLElement>('[data-log-line]')];
}

export function alertText(): string | null {
  return screen.queryByRole('alert')?.textContent ?? null;
}
