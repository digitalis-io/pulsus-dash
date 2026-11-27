/**
 * The board list widget's test kit (plan #216 Part 2a §5): Board list bodies under a memory router
 * at `/t/<tenant>/board/<uid>`, a `retry: false` query client, `ApiContext`, the UTC zone and,
 * optionally, an `InspectorHost`; a deferred Api whose list calls the test settles; and lookups
 * into the view.
 */
import { act, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { Api } from '../api/Api';
import type { BoardPage, RefPage, VisOptions, WidgetPanelSpec } from '../api/types';
import { ApiContext } from '../app/providers';
import { InspectorHost } from '../inspector/host';
import { createClock } from '../state/clock';
import { TimeZoneContext } from '../state/timeZone';
import { ClockContext } from '../state/useTimeContext';
import { BoardListBody } from '../widgets/boardList/BoardListBody';

/** The board window the harness's URL carries. */
export const LIST_TIME =
  'from=2026-11-26T11%3A00%3A00.000Z&to=2026-11-26T12%3A00%3A00.000Z&refresh=off';

export type ListMethod = 'listStarred' | 'listRecent' | 'listBoards';

/** One list call of the deferred Api. */
export interface ListCall {
  readonly method: ListMethod;
  readonly tenant: string;
  readonly signal: AbortSignal | undefined;
  /** `listRecent`'s limit, `listBoards`' filter. */
  readonly arg: unknown;
  resolve(p: BoardPage | RefPage): void;
  reject(e: unknown): void;
}

/** An Api whose list calls stay pending until the test settles them; other methods throw. */
export function deferredApi(): { api: Api; calls: ListCall[] } {
  const calls: ListCall[] = [];
  const make =
    (method: ListMethod) =>
    (tenant: string, signal?: AbortSignal, arg?: unknown): Promise<BoardPage | RefPage> =>
      new Promise((resolve, reject) => {
        calls.push({ method, tenant, signal, arg, resolve, reject });
      });
  const api = {
    listStarred: make('listStarred'),
    listRecent: make('listRecent'),
    listBoards: make('listBoards'),
  } as unknown as Api;
  return { api, calls };
}

/** An Api that answers each list call from `answer` (a value, or a rejection when an Error). */
export function answerApi(
  answer: (method: ListMethod, arg: unknown) => BoardPage | RefPage | Error,
): Api {
  const make = (method: ListMethod) => (_t: string, _s?: AbortSignal, arg?: unknown) => {
    const a = answer(method, arg);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return {
    listStarred: make('listStarred'),
    listRecent: make('listRecent'),
    listBoards: make('listBoards'),
  } as unknown as Api;
}

export function listPanel(id: string, title: string, options?: VisOptions): WidgetPanelSpec {
  return {
    id,
    title,
    grid: { x: 0, y: 0, w: 6, h: 8 },
    vis: { kind: 'boardList', ...(options === undefined ? {} : { options }) },
  };
}

interface Store {
  panels: readonly WidgetPanelSpec[];
  listeners: Set<() => void>;
}

function Panel({ panel }: { panel: WidgetPanelSpec }) {
  const [table, setTable] = useState(false);
  const headingId = `h-${panel.id}`;
  return (
    <section data-panel-id={panel.id} aria-labelledby={headingId} tabIndex={-1}>
      <h3 id={headingId}>{panel.title}</h3>
      <BoardListBody
        panel={panel}
        headingId={headingId}
        editing={false}
        table={table}
        onTable={setTable}
      />
    </section>
  );
}

function Panels({ store }: { store: Store }) {
  const panels = useSyncExternalStore(
    (l) => {
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
    () => store.panels,
  );
  return panels.map((p) => <Panel key={p.id} panel={p} />);
}

export interface ListHarnessOptions {
  readonly api: Api;
  readonly panels: readonly WidgetPanelSpec[];
  readonly tenant?: string;
  /** The board that holds the widgets. */
  readonly uid?: string;
  readonly host?: boolean;
  readonly queryClient?: QueryClient;
}

export function renderLists(o: ListHarnessOptions) {
  const queryClient =
    o.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const store: Store = { panels: o.panels, listeners: new Set() };
  const body: ReactNode =
    o.host === true ? (
      <InspectorHost
        surface="board"
        filters={[]}
        originKey={() => null}
        onEditQuery={() => undefined}
      >
        <Panels store={store} />
      </InspectorHost>
    ) : (
      <Panels store={store} />
    );
  const router = createMemoryRouter([{ path: '/t/:tenant/board/:uid', element: body }], {
    initialEntries: [`/t/${o.tenant ?? 'demo'}/board/${o.uid ?? 'pay'}?${LIST_TIME}`],
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={o.api}>
        <ClockContext.Provider value={createClock(() => Date.parse('2026-11-26T12:00:00Z'))}>
          <TimeZoneContext.Provider value="UTC">
            <RouterProvider router={router} />
          </TimeZoneContext.Provider>
        </ClockContext.Provider>
      </ApiContext.Provider>
    </QueryClientProvider>,
  );
  const setPanels = (panels: readonly WidgetPanelSpec[]): void => {
    act(() => {
      store.panels = panels;
      for (const l of store.listeners) l();
    });
  };
  return { view, router, queryClient, setPanels };
}

/** Lets pending promises and the timers due within `ms` run (fake timers). */
export async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The panel section of `id`. */
export function panelEl(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
  if (el === null) throw new Error(`no panel ${id}`);
  return el;
}

/** The board list root inside `id`, or null. */
export function listRoot(id: string): HTMLElement | null {
  return panelEl(id).querySelector<HTMLElement>('[data-board-list]');
}

/** The row links of `id`, in order. */
export function rowLinks(id: string): HTMLAnchorElement[] {
  return [...panelEl(id).querySelectorAll<HTMLAnchorElement>('[data-board-list-rows] li > a')];
}

/** The row accessible names of `id`. */
export function rowNames(id: string): string[] {
  return rowLinks(id).map((a) => a.getAttribute('aria-label') ?? '');
}

/** The meter's text in `id` (empty without one). */
export function meterText(id: string): string {
  return panelEl(id).querySelector('[data-coverage-meter]')?.textContent ?? '';
}

/** The sr-only summary of `id`. */
export function summaryText(id: string): string {
  return panelEl(id).querySelector('[data-board-list-summary]')?.textContent ?? '';
}

/** The polite live region of `id`. */
export function liveText(id: string): string {
  return panelEl(id).querySelector('[data-board-list-live]')?.textContent ?? '';
}

export function inPanel(id: string) {
  return within(panelEl(id));
}

export { screen };
