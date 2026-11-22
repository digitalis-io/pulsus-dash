/**
 * Shared setup of the Explore page tests (plan #63 Part C §5, C.3): the app with a fake chart
 * engine, spies that answer, reject or hold `queryRange` and `queryInstant`, the page fixtures and
 * small readers of the page. The test file mocks the editor chunk with `fakeEditor.tsx`.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { StubApi } from '../api/StubApi';
import type { InstantRequest, RangeRequest } from '../api/types';
import type { Completeness, InstantResult, RangeResult } from '../data/decode';
import type { FrameData, SeriesFrame } from '../data/frames';
import type { VisSpec } from '../engine/api';
import { ChartEngineContext } from '../engine/index';
import { fakeEngine } from './fakeEngine';
import { resizeAll } from './fakeResizeObserver';
import { EMPTY_COMPLETENESS, fkey } from './histogramFixtures';
import { renderApp } from './renderApp';

export const W0 = Date.UTC(2026, 10, 19, 12);
export const HOUR = 3_600_000;
export const ABS = 'from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';

/** `/t/<tenant>/explore/metrics?ABS[&q=…]<extra>`. */
export function url(q?: string, extra = '', tenant = 'demo', abs = ABS): string {
  const qs = q === undefined ? '' : `&q=${encodeURIComponent(q)}`;
  return `/t/${tenant}/explore/metrics?${abs}${qs}${extra}`;
}

export function ser(n: number, labels: Record<string, string>, values: number[]): SeriesFrame {
  return {
    key: fkey(n),
    labels,
    timestamps: Float64Array.of(W0, W0 + 5000),
    values: Float64Array.from(values),
  };
}

/** C.3 `range`: the window of ABS at step 5 s. */
export function range(
  series: readonly SeriesFrame[],
  completeness: Completeness = EMPTY_COMPLETENESS,
): RangeResult {
  return { startMs: W0, endMs: W0 + HOUR, stepMs: 5000, series, completeness };
}

export const S1 = range([ser(1, { __name__: 'up', job: 'a' }, [1, 2])]);
export const S2 = range([ser(2, { __name__: 'up', job: 'a' }, [3, 4])]);
export const S3 = range([ser(3, { __name__: 'up', job: 'a' }, [5, 6])]);
export const P1 = range([
  ser(1, { __name__: 'up', job: 'a' }, [1, 2]),
  ser(2, { __name__: 'up', job: 'b' }, [5, 6]),
]);
export const P2 = range([
  ser(1, { __name__: 'up', job: 'a' }, [3, 4]),
  ser(2, { __name__: 'up', job: 'b' }, [7, 8]),
]);
export const P3 = range([ser(2, { __name__: 'up', job: 'b' }, [7, 8])]);

/** A step that never settles on its own: the test releases it, or an abort rejects it. */
export const HOLD = Symbol('hold');
export type Step<T> = T | Error | typeof HOLD;

export interface Call<R, T> {
  readonly tenant: string;
  readonly req: R;
  readonly signal: AbortSignal | undefined;
  release(v: T | Error): void;
}

function answer<R, T>(
  calls: Call<R, T>[],
  steps: readonly Step<T>[],
  tenant: string,
  req: R,
  signal: AbortSignal | undefined,
): Promise<T> {
  const step = steps[calls.length] ?? steps.at(-1);
  return new Promise<T>((resolve, reject) => {
    calls.push({
      tenant,
      req,
      signal,
      release: (v) => {
        if (v instanceof Error) reject(v);
        else resolve(v);
      },
    });
    if (step === HOLD || step === undefined) {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    } else if (step instanceof Error) reject(step);
    else resolve(step);
  });
}

/** `queryRange` answers `steps` in order (the last one repeats). */
export function spyRange(
  api: StubApi,
  steps: readonly Step<RangeResult>[],
): Call<RangeRequest, RangeResult>[] {
  const calls: Call<RangeRequest, RangeResult>[] = [];
  vi.spyOn(api, 'queryRange').mockImplementation((tenant, req, signal) =>
    answer(calls, steps, tenant, req, signal),
  );
  return calls;
}

export function spyInstant(
  api: StubApi,
  steps: readonly Step<InstantResult>[],
): Call<InstantRequest, InstantResult>[] {
  const calls: Call<InstantRequest, InstantResult>[] = [];
  vi.spyOn(api, 'queryInstant').mockImplementation((tenant, req, signal) =>
    answer(calls, steps, tenant, req, signal),
  );
  return calls;
}

export function openExplore(u: string, o: { api?: StubApi; queryClient?: QueryClient } = {}) {
  const engine = fakeEngine();
  const api = o.api ?? new StubApi();
  function Wrapper({ children }: { children: ReactNode }) {
    return <ChartEngineContext.Provider value={engine}>{children}</ChartEngineContext.Provider>;
  }
  const r = renderApp(u, {
    api,
    wrapper: Wrapper,
    ...(o.queryClient === undefined ? {} : { queryClient: o.queryClient }),
  });
  return { ...r, engine, api };
}

/** Waits for the page, then gives the chart host its width (1000 px: step 5 s, window 1m). */
export async function sized(): Promise<void> {
  await screen.findByRole('heading', { level: 2, name: 'Result' });
  act(() => {
    resizeAll(1000, 240);
  });
}

export function runButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Run' });
}

/** `sized()`, then waits for Run to be enabled. */
export async function ready(): Promise<HTMLElement> {
  await sized();
  const run = await screen.findByRole('button', { name: 'Run' });
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  return run;
}

export function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'PromQL query' });
}

export function setDraft(value: string): void {
  fireEvent.input(textbox(), { target: { value } });
}

export function runKey(o: { shiftKey?: boolean; ctrlKey?: boolean } = { shiftKey: true }): void {
  fireEvent.keyDown(textbox(), { key: 'Enter', ...o });
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

export function windowKey(code: 'BracketRight' | 'BracketLeft'): void {
  fireEvent.keyDown(document.body, { key: code === 'BracketRight' ? ']' : '[', code });
}

export type Engine = ReturnType<typeof openExplore>['engine'];

export function lastData(engine: Engine): FrameData | undefined {
  return engine.frames.at(-1)?.last('setData')?.[0] as FrameData | undefined;
}

export function lastSpec(engine: Engine): VisSpec | undefined {
  return engine.frames.at(-1)?.last('setSpec')?.[0] as VisSpec | undefined;
}

/** The drawn series as `{key, values}`, or null when the data is not series. */
export function drawn(engine: Engine): { key: string; values: number[] }[] | null {
  const d = lastData(engine);
  if (d?.kind !== 'series') return null;
  return d.series.map((s) => ({ key: s.key, values: Array.from(s.values) }));
}

export function bodyRows(): HTMLElement[] {
  const t = screen.queryByRole('table');
  return t === null ? [] : within(t).getAllByRole('row').slice(1);
}

/** The text of cell `col` of body row `row`. */
export function cell(row: number, col: number): string | null {
  const r = bodyRows()[row];
  if (r === undefined) return null;
  return within(r).getAllByRole('cell')[col]?.textContent ?? null;
}

export function alertText(): string | null {
  return screen.queryByRole('alert')?.textContent ?? null;
}

export { EMPTY_COMPLETENESS };
