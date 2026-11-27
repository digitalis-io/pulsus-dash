/**
 * The Inspector's navigation stack on the geomap (T24-092, T25-008, T25-011, T25-012, T25 §4.8,
 * §4.9; plan #234 Part 4 §5): `unit:geo-members` (the entries as buttons), `unit:geo-members-fullscreen`,
 * `unit:geo-announce`, `unit:geo-nav`, `unit:geo-nav-life` and `unit:geo-targets` (member rows), on
 * a fake engine under the real Inspector host.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesFrame } from '../data/frames';
import { ChartEngineContext } from '../engine/index';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { host, Inspecting, seen, SIZE, type Kit } from '../test/geoFrameKit';
import { hostProps, installGridLayout, runOf } from '../test/geoHostKit';
import { stubReducedMotion } from '../test/inspectorKit';
import { M12, N, O2, V } from '../vis/geo/fixtures/series';
import GeoMapFrame, { type GeoMapFrameHostProps } from './GeoMapFrame';

let restoreMotion: () => void = () => undefined;
let restoreGrid: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restoreMotion = stubReducedMotion(true);
  restoreGrid = installGridLayout();
});
afterEach(() => {
  cleanup();
  restoreMotion();
  restoreGrid();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const E18 = 'geo:group:{"present":true,"value":"e18"}';

const props = (series: readonly SeriesFrame[], groupBy: string | null): GeoMapFrameHostProps => ({
  ...hostProps(series, { thresholds: null, options: { groupBy } }),
  sizeMemo: SIZE,
  fill: true,
});

const h2 = (): HTMLElement => screen.getByRole('heading', { level: 2 });
const members = (): HTMLElement => {
  const m = document.querySelector<HTMLElement>(
    '[data-inspector]:not([data-closing]) [data-section="members"]',
  );
  expect(m, 'the members section').not.toBeNull();
  if (m === null) throw new Error('no members');
  return m;
};
/** The member entries: their texts, and whether each is a button. */
const entries = (): { text: string; button: boolean }[] =>
  [...members().querySelectorAll('li')].map((li) => ({
    text: li.textContent,
    button: li.querySelector('button') !== null,
  }));
const entryTexts = (): string[] => entries().map((e) => e.text);
const entryAt = (i: number): HTMLElement => {
  const b = members().querySelectorAll('li')[i]?.querySelector('button') ?? null;
  expect(b, `entry ${String(i)} is a button`).not.toBeNull();
  if (b === null) throw new Error('no entry button');
  return b;
};
const more = (): HTMLElement => within(members()).getByRole('button', { name: /^\+\d+ more$/ });
const back = (): HTMLElement => screen.getByRole('button', { name: /^Back to / });
const crumbs = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('nav[aria-label="Inspector path"] li')].map(
    (li) => li.textContent,
  );
const live = (): string => document.querySelector('[data-inspector-live]')?.textContent ?? '';
const legend = (name: RegExp): HTMLElement => screen.getByRole('button', { name });

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const nKeys = (from: number, to: number): string =>
  range(from, to)
    .map((i) => `n${String(i).padStart(2, '0')}`)
    .join(',');
const e18Texts = (to: number): string[] => [
  '{env="e18", lat="10", lon="10"}',
  ...range(19, to).map((i) => `{env="e18", lat="10", lon="10", pod="p${String(i)}"}`),
];
const N27 = '{env="e18", lat="10", lon="10", pod="p27"}';

/** N on panel p1, the legend's `other (12)` pressed. */
function openN(): Kit {
  const k = host(props(N(), 'env'));
  fireEvent.click(legend(/^other \(12\)/));
  expect(h2()).toHaveTextContent('other (12)');
  return k;
}

/** From the open aggregate: "+4 more", entry 11 (e18). */
function pushE18(): void {
  fireEvent.click(more());
  fireEvent.click(entryAt(11));
  expect(h2()).toHaveTextContent('e18');
}

/** From the open e18 group: "+4 more", entry 9 (n27). */
function pushN27(): void {
  fireEvent.click(more());
  fireEvent.click(entryAt(9));
  expect(h2()).toHaveTextContent(N27);
}

describe('unit:geo-members (the sheet)', () => {
  it('M12: cluster:m12 → "+4 more" → entry 10 opens m11; a refresh keeps the snapshot', () => {
    const k = host(props(M12(), null));
    const keys = M12().map((s) => s.key);
    act(() => {
      k.frame().emit('select', {
        source: 'pointer',
        item: { kind: 'geo', id: 'cluster:m12', keys },
      });
    });
    const text = (i: number): string =>
      `{lat="10", lon="10", pod="p${String(i).padStart(2, '0')}"}`;
    expect(entries()).toEqual(range(1, 8).map((i) => ({ text: text(i), button: true })));
    expect(more()).toHaveTextContent('+4 more');
    fireEvent.click(more());
    expect(entries()).toEqual(range(1, 12).map((i) => ({ text: text(i), button: true })));
    fireEvent.click(entryAt(10));
    expect(h2()).toHaveTextContent(text(11));
    expect(k.h.selection()).toBe('m11|null|null');
    k.set({ run: runOf(M12().filter((s) => s.key !== 'm11')) });
    expect(h2()).toHaveTextContent(text(11));
    fireEvent.click(back());
    fireEvent.click(more());
    expect(entryTexts()).toHaveLength(12);
    fireEvent.click(entryAt(10));
    expect(h2()).toHaveTextContent(text(11));
  });

  it('N: other (12) → e18 → n27, each list resolving 12; after a refresh the same entries open', () => {
    const k = openN();
    expect(entries()).toEqual(range(7, 14).map((i) => ({ text: `e${String(i)}`, button: true })));
    fireEvent.click(more());
    expect(entryTexts()).toEqual(range(7, 18).map((i) => `e${String(i)}`));
    fireEvent.click(entryAt(11));
    expect(h2()).toHaveTextContent('e18');
    expect(entryTexts()).toEqual(e18Texts(25));
    fireEvent.click(more());
    expect(entryTexts()).toEqual(e18Texts(29));
    expect(entries().every((e) => e.button)).toBe(true);
    fireEvent.click(entryAt(9));
    expect(h2()).toHaveTextContent(N27);
    k.set({ run: runOf(N().filter((s) => s.key !== 'n27')) });
    expect(h2()).toHaveTextContent(N27);
    fireEvent.click(back());
    pushN27();
    fireEvent.click(back());
    fireEvent.click(back());
    pushE18();
  });
});

describe('unit:geo-members-fullscreen', () => {
  it('a full screen of the panel opens and closes: every press resolves 12 with parallel labels', () => {
    const engine = fakeEngine();
    const k = host(props(N(), 'env'), engine);
    fireEvent.click(legend(/^other \(12\)/));
    pushE18();
    const tree = (full: boolean) => (
      <ChartEngineContext.Provider value={engine}>
        <div data-panel-id="p1">
          <Inspecting p={k.props} />
        </div>
        {full && <GeoMapFrame {...props(N(), 'env')} key="full" />}
      </ChartEngineContext.Provider>
    );
    const presses = (): void => {
      fireEvent.click(more());
      expect(entryTexts()).toEqual(e18Texts(29));
      expect(k.h.api().resolveMembers('p1', E18)?.labels?.[1]).toEqual({
        env: 'e18',
        lat: '10',
        lon: '10',
        pod: 'p19',
      });
      fireEvent.click(back());
      fireEvent.click(more());
      expect(entryTexts()).toEqual(range(7, 18).map((i) => `e${String(i)}`));
      expect(k.h.api().resolveMembers('p1', 'geo:other:geo')?.labels?.[0]).toEqual({ env: 'e7' });
      expect(document.body.textContent).not.toContain('no longer available');
    };
    k.h.rerender(tree(true));
    presses();
    k.h.rerender(tree(false));
    pushE18();
    presses();
  });
});

describe('unit:geo-announce', () => {
  it('N, 600 ms apart: the levels; Back reads the view again; a quick run reads only the last', () => {
    vi.useFakeTimers();
    const k = host(props(N(), 'env'));
    const step = (): void => {
      act(() => {
        vi.advanceTimersByTime(600);
      });
    };
    const L1 = 'Inspector: other (12), 12 groups, 23 series';
    const L2 = 'Inspector: Level 2: e18, 12 series';
    const L3 = `Inspector: Level 3: ${N27}, 27 ms`;
    fireEvent.click(legend(/^other \(12\)/));
    expect(live()).toBe(L1);
    step();
    pushE18();
    expect(live()).toBe(L2);
    step();
    pushN27();
    expect(live()).toBe(L3);
    step();
    fireEvent.click(back());
    expect(live()).toBe(L2);
    step();
    fireEvent.click(back());
    expect(live()).toBe(L1);
    step();
    pushE18();
    expect(live()).toBe(L2);
    // n27, Back, n27 within 100 ms: one write, the last, 500 ms after the last one.
    act(() => {
      vi.advanceTimersByTime(20);
    });
    pushN27();
    fireEvent.click(back());
    pushN27();
    expect(live()).toBe(L2);
    act(() => {
      vi.advanceTimersByTime(470);
    });
    expect(live()).toBe(L2);
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(live()).toBe(L3);
    expect(k.h.aside()).not.toBeNull();
  });
});

describe('unit:geo-nav', () => {
  it('N by keys: other (12) → e18 → n27 → Back → Back → close; one request', async () => {
    const k = host(props(N(), 'env'));
    const user = userEvent.setup();
    const press = async (el: HTMLElement): Promise<void> => {
      act(() => {
        el.focus();
      });
      await user.keyboard('{Enter}');
    };
    const other = legend(/^other \(12\)/);
    await press(other);
    expect(seen).toHaveLength(1);
    expect(document.activeElement).toBe(h2());
    expect(k.h.selection()).toBe(`${nKeys(7, 29)}|null|null`);
    await press(more());
    await press(entryAt(11));
    expect(document.activeElement).toBe(h2());
    expect(k.h.selection()).toBe(`${nKeys(18, 29)}|null|null`);
    expect(crumbs()).toEqual(['other (12)', 'e18']);
    await press(more());
    await press(entryAt(9));
    expect(document.activeElement).toBe(h2());
    expect(k.h.selection()).toBe('n27|null|null');
    expect(crumbs()).toEqual(['other (12)', 'e18', N27]);
    await press(back());
    expect(document.activeElement).toBe(h2());
    expect(h2()).toHaveTextContent('e18');
    expect(k.h.selection()).toBe(`${nKeys(18, 29)}|null|null`);
    await press(back());
    expect(document.activeElement).toBe(h2());
    expect(k.h.selection()).toBe(`${nKeys(7, 29)}|null|null`);
    expect(crumbs()).toEqual([]);
    await press(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(k.h.aside()).toBeNull();
    expect(document.activeElement).toBe(other);
    expect(seen).toHaveLength(1);
  });
});

describe('unit:geo-nav-life', () => {
  it('(a) a refresh dropping n27: the views keep their snapshot', () => {
    const k = openN();
    pushE18();
    pushN27();
    k.set({ run: runOf(N().filter((s) => s.key !== 'n27')) });
    expect(h2()).toHaveTextContent(N27);
    fireEvent.click(back());
    fireEvent.click(more());
    expect(entryTexts()).toEqual(e18Texts(29));
    expect(k.h.api().resolveMembers('p1', E18)?.texts).toHaveLength(12);
  });

  it('(b) V: a window change after the push does not move the marker pivots', async () => {
    const k = host(props(V(), null));
    const openV1 = (): string | null => {
      act(() => {
        k.frame().emit('select', {
          source: 'pointer',
          item: { kind: 'geo', id: 'cluster:v1', keys: ['v1', 'v2'] },
        });
      });
      fireEvent.click(entryAt(0));
      const logs = document.querySelector<HTMLAnchorElement>('a[data-pivot="logs"]');
      expect(logs, 'the Logs chip').not.toBeNull();
      return logs?.getAttribute('href') ?? null;
    };
    const w1 = openV1();
    expect(new URL(w1 ?? '', 'http://x').searchParams.get('q')).toBe('{service_name="checkout"}');
    await act(async () => {
      await k.h.router.navigate('/t/acme/board/b1?from=now-2h&to=now&refresh=30s');
    });
    expect(document.querySelector('a[data-pivot="logs"]')?.getAttribute('href')).toBe(w1);
    // A new inspect takes the window of its own moment.
    expect(openV1()).not.toBe(w1);
  });

  const closers: [string, (k: Kit) => Promise<void> | void][] = [
    [
      'close',
      () => {
        fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
      },
    ],
    [
      'a query edit',
      (k) => {
        k.h.rerender(undefined, { originKey: () => 'k2' });
      },
    ],
    [
      'the panel removed',
      (k) => {
        k.h.rerender(<p>gone</p>, { originKey: () => null });
      },
    ],
    [
      'a route change',
      async (k) => {
        await act(async () => {
          await k.h.router.navigate('/t/acme/board/b2?from=now-1h&to=now&refresh=30s');
        });
      },
    ],
    [
      'a tenant reset',
      async (k) => {
        await act(async () => {
          await k.h.router.navigate('/t/other/board/b1?from=now-1h&to=now&refresh=30s');
        });
      },
    ],
  ];
  for (const [name, closeBy] of closers) {
    it(`(c) ${name} at n27: the Inspector closed, the stack gone, a stale press does nothing`, async () => {
      const k = openN();
      pushE18();
      pushN27();
      const stale = back();
      await closeBy(k);
      expect(k.h.aside()).toBeNull();
      fireEvent.click(stale);
      expect(k.h.aside()).toBeNull();
      expect(k.h.api().resolveMembers('p1', 'geo:other:geo')).toBeNull();
      expect(k.h.api().resolveMembers('p1', E18)).toBeNull();
      expect(crumbs()).toEqual([]);
    });
  }

  it('(d) e18 and e17 pressed in one tick: e18 pushed, e17 a no-op (stale depth)', () => {
    const k = openN();
    fireEvent.click(more());
    const e18 = entryAt(11);
    const e17 = entryAt(10);
    act(() => {
      e18.click();
      e17.click();
    });
    expect(h2()).toHaveTextContent('e18');
    expect(crumbs()).toEqual(['other (12)', 'e18']);
    expect(k.h.selection()).toBe(`${nKeys(18, 29)}|null|null`);
  });

  it('(e) the panel unmounted: the request closed, no answer for the old ids', () => {
    const k = openN();
    pushE18();
    k.h.rerender(<p>no panel</p>, { originKey: () => null });
    expect(k.h.aside()).toBeNull();
    expect(k.h.api().resolveMembers('p1', E18)).toBeNull();
    expect(k.h.api().resolveMembers('p1', 'geo:other:geo')).toBeNull();
  });

  it('(f) "+4 more", push e18, Back: each view starts with its own 8 and "+4 more"', () => {
    openN();
    pushE18();
    expect(entryTexts()).toEqual(e18Texts(25));
    expect(more()).toHaveTextContent('+4 more');
    expect(entries().every((e) => e.button)).toBe(true);
    fireEvent.click(back());
    expect(entryTexts()).toEqual(range(7, 14).map((i) => `e${String(i)}`));
    expect(more()).toHaveTextContent('+4 more');
    expect(entries().every((e) => e.button)).toBe(true);
    fireEvent.click(entryAt(0));
    expect(h2()).toHaveTextContent('e7');
    fireEvent.click(back());
    pushE18();
    fireEvent.click(entryAt(0));
    expect(h2()).toHaveTextContent('{env="e18", lat="10", lon="10"}');
  });
});

describe('unit:geo-targets (member rows)', () => {
  it('O2: other (3) → e8 → q10; a refetch dropping q10 leaves the group as it was', () => {
    const k = host(props(O2(), 'env'));
    fireEvent.click(legend(/^other \(3\)/));
    fireEvent.click(within(members()).getByRole('button', { name: 'e8' }));
    expect(k.h.selection()).toBe('q08,q10|null|null');
    expect(
      k.h.api().resolveMembers('p1', 'geo:group:{"present":true,"value":"e8"}')?.texts,
    ).toEqual(['{env="e8"}', '{env="e8", pod="b"}']);
    expect(entryTexts()).toEqual(['{env="e8"}', '{env="e8", pod="b"}']);
    fireEvent.click(entryAt(1));
    expect(h2()).toHaveTextContent('{env="e8", pod="b"}');
    expect(k.h.selection()).toBe('q10|null|null');
    expect(document.querySelector('[data-section="members"]')).toBeNull();
    k.set({ run: runOf(O2().filter((s) => s.key !== 'q10')) });
    fireEvent.click(back());
    expect(entryTexts()).toEqual(['{env="e8"}', '{env="e8", pod="b"}']);
    expect(seen).toHaveLength(1);
  });
});
