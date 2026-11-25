/**
 * The virtualised log list (plan #66 Part B §3.7, §4.5; VIZ-034 subset, VIZ-067, PRF-020): a DOM
 * list (ADR-0007) virtualised by `@tanstack/react-virtual` over a slice of the pager's buffer of
 * at most `view.cap` rows and `view.maxPx` pixels. The slice moves only at rest (no scroll and no
 * touch down), and every move restores the viewport by an explicit anchor, so eviction, re-fetch,
 * re-slicing and wrap never move what the reader sees. Rows are a fixed `size.log-row` without
 * wrap and measured with wrap (at most 100 lines; a longer line scrolls inside its row). The gutter
 * shows a level-coloured bar, a three-letter glyph and the level name for screen readers.
 */
import { elementScroll, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { LOG_LEVELS } from '../data/logFrame';
import { formatLogTime } from '../i18n/format';
import { t } from '../i18n/t';
import type { InspectorTarget } from '../inspector/types';
import { Button } from '../kit/Button';
import { Checkbox } from '../kit/Checkbox';
import { cx } from '../kit/cx';
import { SegmentedControl } from '../kit/SegmentedControl';
import { useTimeZone } from '../state/timeZone';
import { font, size } from '../styles/tokens';
import { RowEstimates } from './estimates';
import { wrapLines } from './logBuffer';
import { LEVEL_GLYPH, LEVEL_NAME } from './levels';
import type { LogPager, LogPagerState } from './logPager';
import {
  DEFAULT_VIEW,
  anchorOf,
  growSlice,
  layoutOf,
  ordAt,
  restoreOffset,
  sliceAround,
  startOf,
  wantsRecentre,
  type Anchor,
  type Layout,
  type Slice,
  type ViewLimits,
} from './slice';
import styles from './LogStream.module.css';

export const PREFETCH_ROWS = 2_000;
export const OVERSCAN = 10;

const ROW_PX = size['log-row'];
const SENTINEL_PX = size['log-sentinel'];
/** A monospace column at `font.size.sm`. */
const COLUMN_PX = font.size.sm * font.advance.mono;
/** The gutter and timestamp, before any line is mounted to measure. */
const LINE_INSET_PX = 240;
/** Frames the wrapped re-slice re-applies its anchor while rows measure (§4.5 step 4). */
const RESTORE_FRAMES = 10;

export interface LogStreamHandle {
  /** Clamped to the held range; re-slices around `ord`, then aligns it to the top. */
  scrollToOrd(ord: number): void;
}

/** Why a re-slice wrote `scrollTop` (B.4): `edge`, `extent` and `hard` are §4.5's triggers. */
export type ResliceCause = 'edge' | 'extent' | 'hard' | 'wrap' | 'scrollTo';

export interface LogStreamProps {
  readonly pager: LogPager;
  /** The list's accessible name. */
  readonly label: string;
  readonly wrap: boolean;
  readonly onWrapChange: (wrap: boolean) => void;
  /** The order control shows `pager.input.direction`. */
  readonly onDirectionChange: (d: 'backward' | 'forward') => void;
  /** Drift's "Run again": the caller makes a new pager. */
  readonly onRerun: () => void;
  /** Rows from either end of the held range at which that end loads (default PREFETCH_ROWS). */
  readonly prefetchRows?: number;
  /** DEFAULT_VIEW unless a test or the harness narrows it. */
  readonly view?: ViewLimits;
  /** Called after each `scrollTop` write `LogStream` makes (the harness counts them, E6). */
  readonly onScrollWrite?: () => void;
  /** Called when a re-slice decides to write, before its commit (the harness records it, B.4). */
  readonly onReslice?: (cause: ResliceCause, isScrolling: boolean) => void;
  /** 'bound' (default): `wrapLines`; 'row': every wrapped row estimated 20 px (the harness's E7 only). */
  readonly wrapEstimate?: 'bound' | 'row';
  readonly ref?: Ref<LogStreamHandle>;
  /** A row click or Enter/Space on a focused row (T25-005); absent without an Inspector host. */
  readonly onInspect?: (
    t: InspectorTarget,
    source: 'pointer' | 'keyboard',
    returnFocus: HTMLElement | null,
  ) => void;
}

interface Restore {
  readonly anchor: Anchor;
  readonly cause: ResliceCause;
}

interface ViewState {
  readonly pager: LogPager;
  readonly slice: Slice;
  /** Set with a re-slice; its layout effect writes `scrollTop`, then clears it. */
  readonly restore: Restore | null;
}

/** The committed positions the anchor of a wrap change is taken from. */
interface Committed {
  readonly items: readonly { index: number; start: number; end: number }[];
  /** `scrollTop` at that commit: the virtualiser's measurements of the next commit can move it. */
  readonly scrollTop: number;
  readonly slice: Slice;
  readonly layout: Layout;
}

/** A wrapped row's border-box height; never less than one line. */
function measureRow(el: Element, entry: ResizeObserverEntry | undefined): number {
  const box = entry?.borderBoxSize[0];
  const px = box === undefined ? el.getBoundingClientRect().height : box.blockSize;
  return Math.max(ROW_PX, Math.round(px));
}

const sameSlice = (a: Slice, b: Slice): boolean => a.start === b.start && a.end === b.end;

function initialSlice(pager: LogPager, view: ViewLimits): Slice {
  const b = pager.buffer;
  return sliceAround(b.firstOrd, b.firstOrd, b.endOrd, view, () => ROW_PX);
}

/** First and last visible ordinal, clamped into the slice (sentinels map to its edges). */
function visibleOrds(
  range: { startIndex: number; endIndex: number } | null,
  s: Slice,
  l: Layout,
): { a: number; b: number } {
  if (s.end <= s.start || range === null) return { a: s.start, b: s.start };
  const ord = (i: number, edge: number): number => {
    const o = ordAt(i, s, l);
    return o === 'head' ? s.start : o === 'tail' ? s.end - 1 : Math.min(Math.max(o, s.start), edge);
  };
  return { a: ord(range.startIndex, s.end - 1), b: ord(range.endIndex, s.end - 1) };
}

export function LogStream(props: LogStreamProps): JSX.Element | null {
  const {
    pager,
    label,
    wrap,
    onWrapChange,
    onDirectionChange,
    onRerun,
    prefetchRows = PREFETCH_ROWS,
    view: limits = DEFAULT_VIEW,
    onScrollWrite,
    onReslice,
    wrapEstimate = 'bound',
    ref,
  } = props;
  const state = useSyncExternalStore(pager.subscribe, pager.getState);
  // The pixel bounds are the list's: the rows get them less the room of both sentinels.
  const view = useMemo(
    () => ({
      ...limits,
      maxPx: limits.maxPx - 2 * SENTINEL_PX,
      hardPx: limits.hardPx - 2 * SENTINEL_PX,
    }),
    [limits],
  );
  const tz = useTimeZone();
  const buffer = pager.buffer;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** The mounted scroller, as state: its input listeners follow the element (a series result
   *  removes it, a later stream mounts another). */
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const committedRef = useRef<Committed | null>(null);
  const cancelRestoreRef = useRef<(() => void) | null>(null);
  const [perLine, setPerLine] = useState(80);
  const [touching, setTouching] = useState(false);
  const scrollerCallback = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    setScrollerEl(el);
    // A removed scroller ends any touch on it: no touchend will come.
    if (el === null) setTouching(false);
  }, []);
  const [wrapSeen, setWrapSeen] = useState(wrap);
  /** The reader's last scroll direction (per pager), as state: a change runs the load decision
   *  of §4.5 even when nothing scrolls (a wheel at an edge). */
  const [dirState, setDirState] = useState<{ pager: LogPager; dir: 'down' | 'up' | null }>({
    pager,
    dir: null,
  });
  const direction = dirState.pager === pager ? dirState.dir : null;
  const setDirection = useCallback(
    (dir: 'down' | 'up') => {
      setDirState((d) => (d.pager === pager && d.dir === dir ? d : { pager, dir }));
    },
    [pager],
  );
  /** The offset of the last programmatic write (LogStream's or the virtualiser's): its scroll
   *  event is not the reader's. */
  const programmaticRef = useRef<number | null>(null);

  // A new pager starts at its first row (§4.5).
  const [vs, setVs] = useState<ViewState>(() => ({
    pager,
    slice: initialSlice(pager, view),
    restore: null,
  }));
  let current = vs;
  if (vs.pager !== pager) {
    current = { pager, slice: initialSlice(pager, view), restore: null };
    setVs(current);
  }
  const slice = current.slice;
  const layout = layoutOf(slice, state.firstOrd, state.endOrd, state.atStart);

  // A row's estimate is kept once made, so a row evicted while the list scrolls keeps its last
  // known height as a placeholder and nothing below it moves (§3.5); it is dropped once the row is
  // neither held nor in the slice (the effect below).
  const estimates = useMemo(
    () => new RowEstimates(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new cache whenever the estimate rule changes
    [buffer, wrap, wrapEstimate, perLine],
  );
  const estimateOrd = useCallback(
    (ord: number): number => {
      if (!wrap || wrapEstimate === 'row') return ROW_PX;
      const known = estimates.get(ord);
      if (known !== undefined) return known;
      const row = buffer.rowAt(ord);
      if (row === null) return ROW_PX;
      const px = ROW_PX * wrapLines(row, perLine);
      estimates.set(ord, px);
      return px;
    },
    [buffer, wrap, wrapEstimate, perLine, estimates],
  );
  const getItemKey = useCallback(
    (i: number): number | string => ordAt(i, slice, layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout is a function of these
    [slice.start, slice.end, layout.head, layout.tail],
  );
  const estimateSize = useCallback(
    (i: number): number => {
      const o = getItemKey(i);
      return typeof o === 'number' ? estimateOrd(o) : SENTINEL_PX;
    },
    [getItemKey, estimateOrd],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- the build has no React Compiler; nothing memoises the virtualiser's functions
  const virtualizer = useVirtualizer({
    count: layout.count,
    getScrollElement: () => scrollerRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    anchorTo: 'start',
    followOnAppend: false,
    isScrollingResetDelay: 150,
    measureElement: measureRow,
    scrollToFn: (offset, options, instance) => {
      programmaticRef.current = offset + (options.adjustments ?? 0);
      elementScroll(offset, options, instance);
    },
  });
  const items: VirtualItem[] = virtualizer.getVirtualItems();
  const totalPx = virtualizer.getTotalSize();
  const sentinelsPx = (layout.head ? SENTINEL_PX : 0) + (layout.tail ? SENTINEL_PX : 0);
  /** The slice's rows only: what `maxPx` and `hardPx` bound. */
  const extentPx = totalPx - sentinelsPx;
  const isScrolling = virtualizer.isScrolling;
  const range = virtualizer.range;
  const rangeStart = range?.startIndex ?? -1;
  const rangeEnd = range?.endIndex ?? -1;

  const heightOf = (ord: number): number =>
    wrap ? (virtualizer.itemSizeCache.get(ord) ?? estimateOrd(ord)) : ROW_PX;

  const write = (scroller: HTMLElement, top: number): void => {
    scroller.scrollTop = top;
    programmaticRef.current = scroller.scrollTop;
    onScrollWrite?.();
  };

  /** §4.5 re-slice: steps 1–3 (step 3's write is the layout effect below). */
  const reslice = (cause: ResliceCause, anchor?: Anchor): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const a =
      anchor ?? anchorOf(items, scroller.scrollTop, slice, layout, state.firstOrd, state.endOrd);
    const next = sliceAround(a.ord, state.firstOrd, state.endOrd, view, heightOf);
    const forced = cause === 'wrap' || cause === 'scrollTo';
    if (!forced && sameSlice(next, slice) && extentPx <= view.maxPx) return;
    onReslice?.(cause, isScrolling || touching);
    // Until the virtualiser has seen the restored offset, the anchor's rows are what is shown.
    const rows = Math.ceil(scroller.clientHeight / ROW_PX);
    pager.protect({ from: a.ord - OVERSCAN, to: a.ord + rows + OVERSCAN + 1 });
    const restore = { anchor: a, cause };
    // A re-slice decided in an effect applies only to the state it was decided on; an explicit
    // one (scrollToOrd, wrap) always applies.
    setVs((v) =>
      forced || (v.pager === pager && sameSlice(v.slice, slice) && v.restore === null)
        ? { pager, slice: next, restore }
        : v,
    );
  };

  // Only held rows and the slice's rows (placeholders included) are ever estimated or anchored to:
  // every other estimate goes, so the cache is bounded by the buffer and the slice.
  useEffect(() => {
    estimates.retain(Math.min(state.firstOrd, slice.start), Math.max(state.endOrd, slice.end));
  }, [estimates, state.firstOrd, state.endOrd, slice.start, slice.end]);

  // The columns per line (§3.7 estimateSize): the scroller's width less the first mounted line's
  // inset in its row (the gutter and the timestamp), the same with or without wrap (an unwrapped
  // row is as wide as its line), so a wrap change starts from the right estimate.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const line = listRef.current?.querySelector<HTMLElement>('[data-log-line]');
    const inset =
      line !== null && line !== undefined && line.offsetLeft > 0 ? line.offsetLeft : LINE_INSET_PX;
    const width = (scroller?.clientWidth ?? 0) - inset;
    const next = Math.max(1, Math.floor(width / COLUMN_PX));
    if (next !== perLine) {
      setPerLine(next);
      if (wrap) virtualizer.measure();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when wrap or the mounted rows change
  }, [wrap, perLine, rangeStart, rangeEnd]);

  // A wrap change: the anchor of the committed positions, every measurement dropped, a re-slice.
  useLayoutEffect(() => {
    if (wrap === wrapSeen) return;
    setWrapSeen(wrap);
    const scroller = scrollerRef.current;
    const c = committedRef.current;
    if (scroller === null || c === null) return;
    const a = anchorOf(c.items, c.scrollTop, c.slice, c.layout, state.firstOrd, state.endOrd);
    virtualizer.measure();
    reslice('wrap', a);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on a wrap change only
  }, [wrap, wrapSeen]);

  // Rows and the list's height through CSSOM (T08-023); the committed positions are kept.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    list.style.height = `${String(totalPx)}px`;
    const byIndex = new Map(items.map((it) => [it.index, it]));
    for (const el of list.children) {
      if (!(el instanceof HTMLElement)) continue;
      const it = byIndex.get(Number(el.dataset['index']));
      if (it === undefined) continue;
      el.style.transform = `translateY(${String(it.start)}px)`;
      if (el.dataset['placeholder'] !== undefined) el.style.height = `${String(it.size)}px`;
    }
    committedRef.current = {
      items: items.map((it) => ({ index: it.index, start: it.start, end: it.end })),
      scrollTop: scrollerRef.current?.scrollTop ?? 0,
      slice,
      layout,
    };
  });

  // §4.5 step 3 (and step 4 with wrap): restore the anchor after the re-slice's commit.
  useLayoutEffect(() => {
    const r = current.restore;
    const scroller = scrollerRef.current;
    if (r === null || scroller === null) return;
    const maxScroll = (): number => virtualizer.getTotalSize() - scroller.clientHeight;
    // Step 3: the virtualiser's offsets after the commit.
    const target = (): number => {
      virtualizer.getVirtualItems();
      const measured = (i: number): number | undefined => virtualizer.measurementsCache[i]?.start;
      return restoreOffset(
        r.anchor,
        (i) => startOf(i, measured, slice, layout, heightOf, SENTINEL_PX),
        slice,
        layout,
        maxScroll(),
      );
    };
    // Step 4 (wrap): from the laid-out rows, since rows measured before the virtualiser saw the
    // write moved them without a correction. The mounted row nearest the anchor, plus the heights
    // between; `exact` once the anchor row itself is mounted.
    const laidOut = (): { px: number; exact: boolean } => {
      virtualizer.getVirtualItems();
      const list = listRef.current;
      const a = r.anchor.ord;
      let best: { ord: number; top: number } | null = null;
      if (list !== null) {
        const listTop = list.getBoundingClientRect().top;
        for (const el of list.querySelectorAll<HTMLElement>('[data-ord]')) {
          const o = Number(el.dataset['ord']);
          if (best === null || Math.abs(o - a) < Math.abs(best.ord - a)) {
            best = { ord: o, top: el.getBoundingClientRect().top - listTop };
          }
        }
      }
      if (best === null || a < slice.start || a >= slice.end) {
        return { px: target(), exact: false };
      }
      let start = best.top;
      for (let o = best.ord; o < a; o += 1) start += heightOf(o);
      for (let o = a; o < best.ord; o += 1) start -= heightOf(o);
      const px = Math.min(Math.max(start + r.anchor.offsetPx, 0), Math.max(0, maxScroll()));
      return { px, exact: best.ord === a };
    };
    let last = target();
    write(scroller, last);
    setVs((v) => (v.restore === r ? { ...v, restore: null } : v));
    cancelRestoreRef.current?.();
    if (!wrap) return;
    let frames = 0;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
        scroller.removeEventListener(type, stop);
      }
      if (cancelRestoreRef.current === stop) cancelRestoreRef.current = null;
    };
    const tick = () => {
      const next = laidOut();
      frames += 1;
      if ((next.exact && Math.abs(next.px - last) < 1) || frames >= RESTORE_FRAMES) {
        stop();
        return;
      }
      last = next.px;
      if (Math.abs(next.px - scroller.scrollTop) >= 1) write(scroller, next.px);
      raf = requestAnimationFrame(tick);
    };
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      scroller.addEventListener(type, stop, { passive: true });
    }
    cancelRestoreRef.current = stop;
    raf = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a re-slice sets a restore
  }, [current.restore]);

  useEffect(
    () => () => {
      cancelRestoreRef.current?.();
    },
    [],
  );

  // A new pager: back to the top.
  const pagerSeen = useRef(pager);
  useLayoutEffect(() => {
    if (pagerSeen.current === pager) return;
    pagerSeen.current = pager;
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    write(scroller, 0);
  });

  // The reader's scroll direction: from the change of `scrollTop` in each scroll event that no
  // programmatic write made (so a scrollbar drag counts), and from wheel, key and touch input,
  // which also count at an edge, where nothing scrolls. The tail prefetches unless the reader last
  // moved up, the head (an evicted page) only after the reader moved up, so loads at the two ends
  // never evict each other's pages in turn.
  useEffect(() => {
    const scroller = scrollerEl;
    if (scroller === null) return undefined;
    let prevTop = scroller.scrollTop;
    let touchY: number | null = null;
    const set = (down: boolean) => {
      setDirection(down ? 'down' : 'up');
    };
    const onScroll = () => {
      const top = scroller.scrollTop;
      const written = programmaticRef.current;
      if (written !== null && Math.abs(top - written) < 1) {
        programmaticRef.current = null;
      } else if (Math.abs(top - prevTop) >= 1) {
        set(top > prevTop);
      }
      prevTop = top;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) set(e.deltaY > 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowDown', 'PageDown', 'End', ' '].includes(e.key)) set(true);
      else if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) set(false);
    };
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y === undefined || touchY === null || y === touchY) return;
      // A finger moving up scrolls the list down.
      set(y < touchY);
      touchY = y;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('keydown', onKey);
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('keydown', onKey);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, [setDirection, scrollerEl]);

  // A touch down holds every re-slice until it ends (§4.5 "at rest"), on whichever scroller is
  // mounted.
  useEffect(() => {
    const scroller = scrollerEl;
    if (scroller === null) return undefined;
    const down = () => {
      setTouching(true);
    };
    const up = (e: TouchEvent) => {
      if (e.touches.length === 0) setTouching(false);
    };
    scroller.addEventListener('touchstart', down, { passive: true });
    scroller.addEventListener('touchend', up, { passive: true });
    scroller.addEventListener('touchcancel', up, { passive: true });
    return () => {
      scroller.removeEventListener('touchstart', down);
      scroller.removeEventListener('touchend', up);
      scroller.removeEventListener('touchcancel', up);
    };
  }, [scrollerEl]);

  // After a render whose visible range or state changed: protect, grow, load, re-slice (§4.5).
  useEffect(() => {
    if (state.phase !== 'streams' || current.restore !== null) return;
    // Until the virtualiser has seen the scroller's offset (a write's scroll event is async), its
    // items describe another position than `scrollTop`: wait for the scroll event's render.
    const scroller = scrollerRef.current;
    const seen = virtualizer.scrollOffset;
    if (scroller === null || seen === null || Math.abs(seen - scroller.scrollTop) > 1) return;
    const { a, b } = visibleOrds(range, slice, layout);
    pager.protect({ from: a - OVERSCAN, to: b + OVERSCAN + 1 });
    const dir = direction;
    if (layout.tail && state.endOrd - b <= prefetchRows && dir !== 'up') void pager.loadTail();
    if (layout.head && a - state.firstOrd <= prefetchRows && dir === 'up') {
      void pager.loadHead();
    }
    const scrolling = isScrolling || touching;
    if (scrolling) {
      if (extentPx > view.hardPx) {
        reslice('hard');
        return;
      }
    } else if (wantsRecentre(slice, a, b, state.firstOrd, state.endOrd, extentPx, view)) {
      const edge = wantsRecentre(slice, a, b, state.firstOrd, state.endOrd, 0, view);
      reslice(edge ? 'edge' : 'extent');
      return;
    }
    // growSlice is the while-scrolling rule (cap + margin); at rest the slice grows to cap only,
    // else wantsRecentre's `s.end − s.start > cap` would re-slice it back after every growth.
    const grown = growSlice(
      slice,
      state.endOrd,
      scrolling ? view : { ...view, margin: 0 },
      extentPx,
      heightOf,
    );
    if (!sameSlice(grown, slice)) {
      setVs((v) =>
        v.pager === pager && sameSlice(v.slice, slice) && v.restore === null
          ? { pager, slice: grown, restore: null }
          : v,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- §4.5: runs when the visible range, the state or the extent changes
  }, [
    rangeStart,
    rangeEnd,
    state,
    slice,
    isScrolling,
    touching,
    extentPx,
    current.restore,
    direction,
  ]);

  useImperativeHandle(ref, () => ({
    scrollToOrd(ord: number) {
      const b = pager.buffer;
      if (b.endOrd <= b.firstOrd) return;
      const o = Math.min(Math.max(Math.round(ord), b.firstOrd), b.endOrd - 1);
      const scroller = scrollerRef.current;
      if (scroller !== null) {
        const at = anchorOf(items, scroller.scrollTop, slice, layout, state.firstOrd, state.endOrd);
        if (o !== at.ord) setDirection(o < at.ord ? 'up' : 'down');
      }
      reslice('scrollTo', { ord: o, offsetPx: 0 });
    },
  }));

  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (wrap) virtualizer.measureElement(el);
    },
    // perLine: a new ref re-measures every mounted row after the estimate changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [virtualizer, wrap, perLine],
  );

  if (state.phase === 'series') return null;

  const total = state.total;
  const rows = items.map((it) => {
    const o = ordAt(it.index, slice, layout);
    if (o === 'head' || o === 'tail') {
      return (
        <div key={o} data-index={it.index} className={cx(styles['sentinel'])} role="listitem">
          {o === 'head' ? headSentinel(pager, state, onRerun) : tailSentinel(pager, state, onRerun)}
        </div>
      );
    }
    const row = buffer.rowAt(o);
    if (row === null) {
      return (
        <div
          key={o}
          data-index={it.index}
          data-ord={o}
          data-placeholder=""
          className={cx(styles['row'])}
          aria-hidden="true"
        />
      );
    }
    const level = LOG_LEVELS[row.level] ?? 'unknown';
    return (
      <div
        key={o}
        ref={rowRef}
        data-index={it.index}
        data-ord={o}
        data-log-row=""
        data-level={level}
        className={cx(styles['row'])}
        role="listitem"
        aria-posinset={o + 1}
        aria-setsize={total ?? -1}
      >
        <span className={cx(styles['gutter'])}>
          <span className={cx(styles['bar'])} aria-hidden="true" />
          <span className={cx(styles['glyph'])} aria-hidden="true" data-log-glyph="">
            {t(LEVEL_GLYPH[level])}
          </span>
          <span className={cx(styles['srOnly'])}>{t(LEVEL_NAME[level])}</span>
        </span>
        <span className={cx(styles['ts'])}>{formatLogTime(Number(row.tsNs / 1_000_000n), tz)}</span>
        <span className={cx(styles['line'])} data-log-line="">
          {row.line}
        </span>
      </div>
    );
  });

  return (
    <div className={cx(styles['root'])} data-wrap={wrap ? 'true' : 'false'}>
      <div className={cx(styles['toolbar'])}>
        <SegmentedControl
          label={t('logs.order')}
          options={[
            { id: 'backward', label: t('logs.order.backward') },
            { id: 'forward', label: t('logs.order.forward') },
          ]}
          value={pager.input.direction}
          onChange={onDirectionChange}
        />
        <Checkbox isSelected={wrap} onChange={onWrapChange}>
          {t('logs.wrap')}
        </Checkbox>
      </div>
      <div
        ref={scrollerCallback}
        className={cx(styles['scroller'])}
        data-log-scroller=""
        role="region"
        aria-label={label}
        // A scrollable region is a tab stop (as SeriesTable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <div
          ref={listRef}
          className={cx(styles['list'])}
          role="list"
          aria-label={label}
          data-slice-start={slice.start}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}

function tailSentinel(pager: LogPager, s: LogPagerState, onRerun: () => void): ReactNode {
  if (s.phase === 'pending') return t('logs.loading');
  if (s.phase === 'failed' || s.tail.status === 'error') {
    return (
      <>
        {t('logs.failed')}
        <Button onPress={() => void pager.retry('tail')}>{t('logs.retry')}</Button>
      </>
    );
  }
  if (s.tail.status === 'loading') return t('logs.loadingMore');
  if (s.tail.status === 'drift') {
    return (
      <>
        {t('logs.drift')}
        <Button onPress={onRerun}>{t('logs.rerun')}</Button>
      </>
    );
  }
  if (s.atEnd) return s.total === 0 ? t('logs.empty') : t('logs.end');
  return <Button onPress={() => void pager.loadTail()}>{t('logs.loadMore')}</Button>;
}

function headSentinel(pager: LogPager, s: LogPagerState, onRerun: () => void): ReactNode {
  switch (s.head.status) {
    case 'loading':
      return t('logs.loadingEarlier');
    case 'error':
      return (
        <>
          {t('logs.failed')}
          <Button onPress={() => void pager.retry('head')}>{t('logs.retry')}</Button>
        </>
      );
    case 'drift':
      return (
        <>
          {t('logs.drift')}
          <Button onPress={onRerun}>{t('logs.rerun')}</Button>
        </>
      );
    case 'idle':
      return <Button onPress={() => void pager.loadHead()}>{t('logs.loadEarlier')}</Button>;
  }
}
