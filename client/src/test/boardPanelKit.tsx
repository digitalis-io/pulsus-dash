/**
 * Shared setup of the board panel tests (plan #64 §5.1): the board on a stub with `queryRange` and
 * `queryInstant` spied, sizing and showing panels, held calls, the menu and the editor's query field.
 * The test files mock the editor chunk (`fakeEditor.tsx`) themselves.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { StubApi, type StubSeed } from '../api/StubApi';
import type { PanelSpec, RangeRequest } from '../api/types';
import type { RangeResult } from '../data/decode';
import type { FrameData } from '../data/frames';
import { LANGUAGES } from '../editor/lang/index';
import { contextSearchString } from '../state/contextSearch';
import { boardWith, engineWrapper, panelOf, panelState } from './boardTestKit';
import { fakeEngine, type FakeFrame } from './fakeEngine';
import { setVisible } from './fakeIntersectionObserver';
import { resizeAll, resizeOf } from './fakeResizeObserver';
import { renderApp } from './renderApp';

export const T12 = Date.UTC(2026, 10, 19, 12);
export const T13 = Date.UTC(2026, 10, 19, 13);
export const HOUR = 3_600_000;
export const ABS = 'from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';
export const ABS24 = 'from=2026-11-18T13:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';
export const REL = 'from=now-1h&to=now&refresh=off';
export const ABS_SEARCH = contextSearchString({
  from: '2026-11-19T12:00:00.000Z',
  to: '2026-11-19T13:00:00.000Z',
  refresh: 'off',
});
export const MIX = 'avg_over_time(x[$__interval]) + rate(y[$__rate_interval])';

export interface Opts {
  search?: string;
  extra?: string;
  now?: number | (() => number);
  seed?: StubSeed;
  url?: string;
}

export function openBoard(panels: readonly PanelSpec[], o: Opts = {}) {
  const api = new StubApi(o.seed ?? boardWith(panels));
  const range = vi.spyOn(api, 'queryRange');
  const instant = vi.spyOn(api, 'queryInstant');
  const engine = fakeEngine();
  const url = o.url ?? `/t/demo/board/b-1?${o.search ?? ABS}${o.extra ?? ''}`;
  const r = renderApp(url, {
    api,
    wrapper: engineWrapper(engine),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { ...r, api, range, instant, engine };
}
export type Board = ReturnType<typeof openBoard>;

/** Waits for the panels, then gives every panel body 1000 × 240 (step 15 s on 1 h, #303). */
export async function ready(...titles: string[]): Promise<void> {
  for (const title of titles) await screen.findByRole('heading', { level: 3, name: title });
  act(() => {
    resizeAll(1000, 240);
  });
}

export function show(...titles: string[]): void {
  for (const title of titles) setVisible(panelOf(title), true);
}

export function hide(...titles: string[]): void {
  for (const title of titles) setVisible(panelOf(title), false);
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => {
        setTimeout(r, 0);
      });
    });
  }
}

/** The language has loaded and every effect it started has run. */
export async function settledLanguage(): Promise<void> {
  await LANGUAGES.promql();
  await flush();
}

export const reqs = (t: Board): RangeRequest[] => t.range.mock.calls.map((c) => c[1]);
export const signals = (t: Board): (AbortSignal | undefined)[] =>
  t.range.mock.calls.map((c) => c[2]);

export async function calls(t: Board, n: number): Promise<void> {
  await waitFor(() => {
    expect(t.range).toHaveBeenCalledTimes(n);
  });
}

/** The live frame drawn inside the panel titled `title`. */
export function frameOf(t: Board, title: string): FakeFrame | undefined {
  const p = panelOf(title);
  return t.engine.frames.findLast((f) => f.disposed === 0 && p.contains(f.canvas));
}

export function lastData(t: Board, title: string): FrameData | undefined {
  return frameOf(t, title)?.last('setData')?.[0] as FrameData | undefined;
}

export function seriesValues(t: Board, title: string): number[][] | null {
  const d = lastData(t, title);
  return d?.kind === 'series' ? d.series.map((s) => Array.from(s.values)) : null;
}

/** The panel shows a frame, sized and drawn (its Loading cover gone, #90). */
export async function settled(t: Board, title: string): Promise<void> {
  await waitFor(() => {
    expect(panelState(title)).toBe('frame');
  });
  const f = await waitFor(() => {
    const x = frameOf(t, title);
    if (x === undefined) throw new Error(`no frame in ${title}`);
    return x;
  });
  const host = panelOf(title).querySelector('[data-chart-frame]');
  if (host === null) throw new Error(`no chart in ${title}`);
  act(() => {
    resizeOf(host, 400, 200);
  });
  act(() => {
    f.draw();
  });
}

export interface Held<R, T> {
  readonly req: R;
  readonly signal: AbortSignal | undefined;
  resolve(v?: T): Promise<void>;
  reject(e: Error): Promise<void>;
}

/** From now on `queryRange` calls wait for the test; `stop()` makes them call through again. */
export function holdRange(t: Board) {
  const held: Held<RangeRequest, RangeResult>[] = [];
  let on = true;
  t.range.mockImplementation((tenant, req, signal) => {
    if (!on) return StubApi.prototype.queryRange.call(t.api, tenant, req, signal);
    return new Promise<RangeResult>((res, rej) => {
      signal?.addEventListener('abort', () => {
        rej(new DOMException('aborted', 'AbortError'));
      });
      held.push({
        req,
        signal,
        resolve: (v) =>
          act(async () => {
            res(v ?? (await StubApi.prototype.queryRange.call(t.api, tenant, req)));
            await Promise.resolve();
          }),
        reject: (e) =>
          act(async () => {
            rej(e);
            await Promise.resolve();
          }),
      });
    });
  });
  return {
    held,
    stop: () => {
      on = false;
    },
  };
}

export function windowKey(key: ']' | '['): void {
  fireEvent.keyDown(document.body, { key, code: key === ']' ? 'BracketRight' : 'BracketLeft' });
}

export function exploreItem(title: string): Promise<HTMLElement> {
  return screen.findByRole('menuitem', { name: 'Open in Explore' }).then((el) => {
    expect(el.closest('[role="menu"]')).toHaveAccessibleName(`Panel menu: ${title}`);
    return el;
  });
}

export async function openMenu(t: Board, title: string): Promise<void> {
  await t.user.click(screen.getByRole('button', { name: `Panel menu: ${title}` }));
  await screen.findByRole('menu', { name: `Panel menu: ${title}` });
}

export async function closeMenu(t: Board): Promise<void> {
  await t.user.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryByRole('menu')).toBeNull();
  });
}

export const qOf = (href: string | null): string | null =>
  href === null ? null : new URL(href, 'http://x').searchParams.get('q');

/** The Open in Explore header tool and menu item of `title`, enabled or not, and the href. */
export async function exploreState(t: Board, title: string) {
  await openMenu(t, title);
  const item = await exploreItem(title);
  const itemHref = item.getAttribute('href');
  const disabled = item.getAttribute('aria-disabled') === 'true';
  await closeMenu(t);
  const name = `Open in Explore: ${title}`;
  const link = screen.queryByRole('link', { name });
  const button = screen.queryByRole('button', { name });
  return { itemHref, disabled, link, button };
}

export async function editorOn(t: Board, title: string): Promise<HTMLElement> {
  await openMenu(t, title);
  await t.user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
  const d = await screen.findByRole('dialog', { name: 'Edit panel' });
  await within(d).findByRole('textbox', { name: 'Query' });
  return d;
}

export function preview(d: HTMLElement): HTMLElement {
  return within(d).getByRole('region', { name: 'Preview' });
}

export function typeQuery(d: HTMLElement, value: string): void {
  fireEvent.input(within(d).getByRole('textbox', { name: 'Query' }), { target: { value } });
}

export function runKeys(d: HTMLElement): void {
  fireEvent.keyDown(within(d).getByRole('textbox', { name: 'Query' }), {
    key: 'Enter',
    shiftKey: true,
  });
}
