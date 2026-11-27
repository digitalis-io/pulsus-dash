// unit:clipboard-denied, unit:inspector-focus, unit:inspector-crossfade and the edge sections of
// unit:inspector-model, through the sheet (T25-003, T25-008, T25-013, T25-015; plan #192 §5).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatValue } from '../i18n/format';
import { P_ORIGIN, P_TARGET, pRequest, renderHost, stubReducedMotion } from '../test/inspectorKit';
import { selectionOf } from '../charts/inspectTarget';
import { frameOf } from '../test/geoKit';
import { N } from '../vis/geo/fixtures/series';
import { geoTarget } from '../vis/geo/targets';
import type { InspectorTarget, InspectRequest } from './types';

const S = { kind: 'time', base: 's' } as const;

let restore: () => void = () => undefined;
afterEach(() => {
  restore();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

const titled = (title: string, o: Partial<InspectRequest> = {}): InspectRequest =>
  pRequest({ origin: { ...P_ORIGIN, title }, target: P_TARGET, ...o });

const layers = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-inspector-content]'),
];

describe('unit:inspector-model (sheet)', () => {
  it('the fixed sections in order, and the empty ones say why', () => {
    restore = stubReducedMotion(true);
    const h = renderHost();
    h.inspect(pRequest());
    const aside = screen.getByRole('complementary', { name: 'p99 latency' });
    const sections = [...aside.querySelectorAll<HTMLElement>('[data-section]')].map(
      (s) => s.dataset['section'],
    );
    expect(sections).toEqual([
      'header',
      'value',
      'details',
      'labels',
      'pivots',
      'query',
      'actions',
    ]);
    h.inspect(
      pRequest({
        origin: { ...P_ORIGIN, query: null },
        target: {
          type: 'value',
          key: null,
          labels: {},
          name: 'T',
          value: NaN,
          tMs: null,
          state: null,
        },
      }),
    );
    expect(within(aside).getByText('no value')).toBeInTheDocument();
    expect(within(aside).getByText('No labels')).toBeInTheDocument();
    expect(within(aside).getByText('No query: run the panel first')).toBeInTheDocument();
  });
});

describe('unit:clipboard-denied', () => {
  it('"Couldn\'t copy" shows for 4 s', async () => {
    restore = stubReducedMotion(true);
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const h = renderHost();
    h.inspect(pRequest());
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(writeText).toHaveBeenCalledWith('2.84');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Couldn't copy")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(screen.queryByText("Couldn't copy")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Couldn't copy")).toBeNull();
  });
});

describe('unit:inspector-focus', () => {
  it('only a keyboard open focuses the heading', () => {
    restore = stubReducedMotion(true);
    const h = renderHost(<button type="button">outside</button>);
    const outside = screen.getByRole('button', { name: 'outside' });
    act(() => {
      outside.focus();
    });
    h.inspect(pRequest({ source: 'pointer' }));
    expect(document.activeElement).toBe(outside);
    h.inspect(pRequest({ source: 'keyboard' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  });

  it('close: returnFocus, else the origin panel, else main', () => {
    restore = stubReducedMotion(true);
    const h = renderHost(
      <main id="main" tabIndex={-1}>
        <section data-panel-id="p1" tabIndex={-1} aria-label="panel">
          x
        </section>
      </main>,
    );
    const detached = document.createElement('button');
    h.inspect(pRequest({ source: 'keyboard', returnFocus: detached }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(document.activeElement).toBe(document.querySelector('[data-panel-id="p1"]'));
    h.inspect(pRequest({ source: 'keyboard', returnFocus: detached }));
    document.querySelector('[data-panel-id="p1"]')?.remove();
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('a disabled chip is described by its reason', () => {
    restore = stubReducedMotion(true);
    const h = renderHost();
    h.inspect(pRequest());
    const traces = screen.getByRole('link', { name: /Traces/ });
    expect(traces).toHaveAttribute('aria-disabled', 'true');
    const id = traces.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toContain('Traces are not available yet');
    const logs = screen.getByRole('link', { name: /Logs ±1 min/ });
    expect(logs).not.toHaveAttribute('aria-disabled');
    expect(logs.getAttribute('href')).toContain('/t/acme/explore/logs');
  });

  it('the live region: at most one write per 500 ms, the latest wins', () => {
    restore = stubReducedMotion(true);
    vi.useFakeTimers();
    const h = renderHost();
    const live = (): string =>
      document.querySelector('[data-inspector-live]')?.textContent ?? '<none>';
    h.inspect(titled('A'));
    expect(live()).toBe(`Inspector: A, ${formatValue(2.84, S)} at 13:41:20`);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    h.inspect(titled('B'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    h.inspect(titled('C'));
    expect(live()).toBe(`Inspector: A, ${formatValue(2.84, S)} at 13:41:20`);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(live()).toBe(`Inspector: C, ${formatValue(2.84, S)} at 13:41:20`);
  });
});

describe('unit:inspector-crossfade', () => {
  it('normal motion: two layers for 150 ms, a third target drops the old one, close lingers', () => {
    restore = stubReducedMotion(false);
    vi.useFakeTimers();
    const h = renderHost();
    h.inspect(titled('A'));
    expect(layers()).toHaveLength(1);
    h.inspect(titled('B'));
    expect(layers()).toHaveLength(2);
    const old = layers().find((l) => l.hasAttribute('data-leaving'));
    expect(old).toBeDefined();
    expect(old).toHaveAttribute('inert');
    expect(old).toHaveAttribute('aria-hidden', 'true');
    expect(old?.textContent).toContain('A');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(layers()).toHaveLength(1);
    expect(layers()[0]?.textContent).toContain('B');
    h.inspect(titled('C'));
    h.inspect(titled('D'));
    h.inspect(titled('E'));
    expect(layers().length).toBeLessThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(document.querySelector('[data-inspector][data-closing]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(document.querySelector('[data-inspector]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector('[data-inspector]')).toBeNull();
  });

  it('reduced motion: one layer at once, close unmounts at once', () => {
    restore = stubReducedMotion(true);
    const h = renderHost();
    h.inspect(titled('A'));
    h.inspect(titled('B'));
    expect(layers()).toHaveLength(1);
    expect(layers()[0]?.textContent).toContain('B');
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(document.querySelector('[data-inspector]')).toBeNull();
  });
});

describe('unit:inspector-viewkey', () => {
  const n = frameOf(N(), { opts: { groupBy: 'env' } });
  const agg = geoTarget(n, n.seq, { kind: 'aggregate' });
  const geoReq = (source: 'pointer' | 'keyboard'): InspectRequest => {
    const target: InspectorTarget = { type: 'geo', target: agg };
    return pRequest({
      origin: { ...P_ORIGIN, title: 'Latency map', unit: { kind: 'time', base: 'ms' } },
      target,
      selection: selectionOf(target),
      source,
    });
  };
  const entry = (name: string): HTMLElement =>
    within(
      document.querySelector<HTMLElement>(
        '[data-inspector-content]:not([data-leaving]) [data-section="members"]',
      ) as HTMLElement,
    ).getByRole('button', { name });
  const back = (): HTMLElement => screen.getByRole('button', { name: /^Back to / });
  const h2 = (): HTMLElement => screen.getByRole('heading', { level: 2 });
  const live = (): string => document.querySelector('[data-inspector-live]')?.textContent ?? '';

  function outsideFocused(): HTMLElement {
    const outside = screen.getByRole('button', { name: 'outside' });
    act(() => {
      outside.focus();
    });
    return outside;
  }

  it('normal motion: each push and pop leaves one inert layer for 150 ms and focuses the h2', () => {
    restore = stubReducedMotion(false);
    vi.useFakeTimers();
    const h = renderHost(<button type="button">outside</button>);
    const outside = outsideFocused();
    h.inspect(geoReq('pointer'));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // A pointer open keeps focus.
    expect(document.activeElement).toBe(outside);
    fireEvent.click(entry('e7'));
    expect(layers()).toHaveLength(2);
    const old = layers().find((l) => l.hasAttribute('data-leaving'));
    expect(old).toHaveAttribute('inert');
    expect(old?.textContent).toContain('other (12)');
    expect(document.activeElement).toBe(h2());
    expect(h2()).toHaveTextContent('e7');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(layers()).toHaveLength(1);
    fireEvent.click(back());
    expect(layers()).toHaveLength(2);
    expect(document.activeElement).toBe(h2());
    expect(h2()).toHaveTextContent('other (12)');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Three quick pushes: at most one leaving layer, the third on top.
    fireEvent.click(entry('e7'));
    fireEvent.click(back());
    fireEvent.click(entry('e8'));
    fireEvent.click(back());
    fireEvent.click(entry('e9'));
    expect(layers().filter((l) => l.hasAttribute('data-leaving')).length).toBeLessThanOrEqual(1);
    expect(layers().filter((l) => !l.hasAttribute('data-leaving'))).toHaveLength(1);
    expect(h2()).toHaveTextContent('e9');
    expect(document.activeElement).toBe(h2());
  });

  it('reduced motion: no leaving layer on a push or a pop; a keyboard open focuses the h2', () => {
    restore = stubReducedMotion(true);
    const h = renderHost(<button type="button">outside</button>);
    outsideFocused();
    h.inspect(geoReq('keyboard'));
    expect(document.activeElement).toBe(h2());
    fireEvent.click(entry('e7'));
    expect(layers()).toHaveLength(1);
    expect(document.activeElement).toBe(h2());
    fireEvent.click(back());
    expect(layers()).toHaveLength(1);
    expect(h2()).toHaveTextContent('other (12)');
    expect(document.activeElement).toBe(h2());
  });

  it('point P, then Q (key 1:0:root): as today; each announced, P again later too', () => {
    restore = stubReducedMotion(false);
    vi.useFakeTimers();
    const h = renderHost(<button type="button">outside</button>);
    const outside = outsideFocused();
    h.inspect(titled('P'));
    expect(document.activeElement).toBe(outside);
    expect(live()).toBe(`Inspector: P, ${formatValue(2.84, S)} at 13:41:20`);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    h.inspect(titled('Q', { source: 'keyboard' }));
    expect(layers()).toHaveLength(2);
    expect(document.activeElement).toBe(h2());
    expect(live()).toBe(`Inspector: Q, ${formatValue(2.84, S)} at 13:41:20`);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    h.inspect(titled('P'));
    expect(live()).toBe(`Inspector: P, ${formatValue(2.84, S)} at 13:41:20`);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The same text again: cleared, then rewritten on the next frame.
    h.inspect(titled('P'));
    expect(live()).toBe('');
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(live()).toBe(`Inspector: P, ${formatValue(2.84, S)} at 13:41:20`);
  });

  it('reduced motion: P → Q replaces the layer at once', () => {
    restore = stubReducedMotion(true);
    const h = renderHost();
    h.inspect(titled('P'));
    h.inspect(titled('Q'));
    expect(layers()).toHaveLength(1);
    expect(layers()[0]?.textContent).toContain('Q');
  });
});
