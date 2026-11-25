/**
 * The Inspector's test kit (plan #192 §5): fixture P (T25 §10), an `InspectorHost` under a memory
 * router with the UTC zone, a probe that hands out the host API and shows the selection, and a
 * `matchMedia` stub for the reduced-motion query.
 */
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type {
  InspectorEnv,
  InspectOrigin,
  InspectorTarget,
  InspectRequest,
} from '../inspector/types';
import {
  InspectorHost,
  useInspector,
  useSelection,
  type InspectorHostApi,
  type InspectorHostProps,
} from '../inspector/host';
import { seriesName } from '../data/frames';
import { createClock } from '../state/clock';
import { TimeZoneContext } from '../state/timeZone';
import { ClockContext } from '../state/useTimeContext';
import type { BoardFilter } from '../state/boardParams';
import { T } from './renderApp';

export const K1 = '00000000000000a1';
export const K2 = '00000000000000a2';
/** 2026-11-19T13:41:20Z. */
export const P_T = Date.UTC(2026, 10, 19, 13, 41, 20);

export const P_ORIGIN: InspectOrigin = {
  surface: 'board',
  panelId: 'p1',
  title: 'p99 latency',
  query: { lang: 'promql', text: 'histogram_quantile(0.99, x)' },
  window: { fromMs: Date.UTC(2026, 10, 19, 12, 44), toMs: Date.UTC(2026, 10, 19, 13, 44) },
  unit: { kind: 'time', base: 's' },
};

export const P_LABELS = { job: 'shop/checkout', quantile: '0.99' } as const;

export const P_TARGET: Extract<InspectorTarget, { type: 'point' }> = {
  type: 'point',
  vis: 'line',
  key: K1,
  labels: P_LABELS,
  name: seriesName(P_LABELS),
  tMs: P_T,
  value: 2.84,
};

export function pRequest(o: Partial<InspectRequest> = {}): InspectRequest {
  return {
    origin: P_ORIGIN,
    target: P_TARGET,
    selection: { keys: [K1], fromMs: null, toMs: null },
    source: 'pointer',
    returnFocus: null,
    ...o,
  };
}

export function pEnv(
  filters: readonly BoardFilter[] = [],
  o: Partial<InspectorEnv> = {},
): InspectorEnv {
  return {
    tenant: 'acme',
    ctx: { search: { from: 'now-1h', to: 'now', refresh: '30s' }, filters },
    timeZone: 'UTC',
    capabilities: { investigations: false, alerting: false, ai: false },
    ...o,
  };
}

/** Hands the host API to the test and shows the selection's keys as `data-sel`. */
function Probe({ onApi }: { onApi: (api: InspectorHostApi | null) => void }) {
  const api = useInspector();
  const sel = useSelection();
  onApi(api);
  return (
    <span
      data-probe=""
      data-sel={
        sel === null ? 'null' : `${sel.keys.join(',')}|${String(sel.fromMs)}|${String(sel.toMs)}`
      }
    />
  );
}

export interface HostHarness {
  api(): InspectorHostApi;
  /** The probe's selection text: `null`, or `keys|from|to`. */
  selection(): string | null;
  /** The open (not closing) sheet. */
  aside(): HTMLElement | null;
  router: ReturnType<typeof createMemoryRouter>;
  rerender(children?: ReactNode, p?: Partial<InspectorHostProps>): void;
  unmount(): void;
  inspect(r: InspectRequest): void;
}

export function renderHost(
  children: ReactNode = null,
  p: Partial<Omit<InspectorHostProps, 'children'>> = {},
  url = '/t/acme/board/b1?from=now-1h&to=now&refresh=30s',
): HostHarness {
  let api: InspectorHostApi | null = null;
  const onApi = (a: InspectorHostApi | null): void => {
    api = a;
  };
  let props: Omit<InspectorHostProps, 'children'> = {
    surface: 'board',
    filters: [],
    originKey: () => 'k',
    onEditQuery: () => undefined,
    ...p,
  };
  let kids: ReactNode = children;
  const element = (): ReactNode => (
    <InspectorHost {...props}>
      <Probe onApi={onApi} />
      {kids}
    </InspectorHost>
  );
  const ctl: { force: ((n: number) => void) | null } = { force: null };
  let renders = 0;
  const Root = () => {
    const [, setN] = useState(0);
    useEffect(() => {
      ctl.force = setN;
    }, []);
    return <>{element()}</>;
  };
  const router = createMemoryRouter(
    [
      { path: '/t/:tenant/board/:uid', element: <Root /> },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [url] },
  );
  const tree = (): ReactNode => (
    <QueryClientProvider client={new QueryClient()}>
      <ClockContext.Provider value={createClock(() => T)}>
        <TimeZoneContext.Provider value="UTC">
          <RouterProvider router={router} />
        </TimeZoneContext.Provider>
      </ClockContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree());
  const h: HostHarness = {
    api() {
      if (api === null) throw new Error('no host api');
      return api;
    },
    selection() {
      return document.querySelector<HTMLElement>('[data-probe]')?.dataset['sel'] ?? null;
    },
    aside() {
      return document.querySelector<HTMLElement>('[data-inspector]:not([data-closing])');
    },
    router,
    rerender(c, q) {
      if (c !== undefined) kids = c;
      if (q !== undefined) props = { ...props, ...q };
      renders += 1;
      const n = renders;
      act(() => {
        ctl.force?.(n);
      });
    },
    unmount: view.unmount,
    inspect(r) {
      act(() => {
        h.api().inspect(r);
      });
    },
  };
  return h;
}

/** `matchMedia` answering `prefers-reduced-motion: reduce` with `reduce`; returns the restore. */
export function stubReducedMotion(reduce: boolean): () => void {
  const prev = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string): MediaQueryList =>
      ({
        matches: q.includes('prefers-reduced-motion') ? reduce : false,
        media: q,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
  return () => {
    if (prev !== undefined) Object.defineProperty(window, 'matchMedia', prev);
    else Reflect.deleteProperty(window, 'matchMedia');
  };
}

/** A keydown on `target` (default: the focused element), bubbling; returns it. */
export function esc(
  target: EventTarget = document.activeElement ?? document.body,
  o: KeyboardEventInit = {},
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...o });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}
