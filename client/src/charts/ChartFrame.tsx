/**
 * `<ChartFrame>`: one chart on one `<canvas>`, drawn by the engine behind the ADR-0014 §3 seam
 * (plan #58 §4.2). The component owns the semantic side: the Context (brush → URL), validation,
 * the DOM tooltip, the notices, the summary label and the keyboard crosshair slider. The engine
 * owns scales, marks, picking and the brush gesture. The canvas is created for the frame's lifetime,
 * so a later `transferControlToOffscreen()` (#68) survives StrictMode re-mounts.
 *
 * Camera (#93, ADR-0020): the engine previews zoom and pan and reports one `commit` per gesture. A
 * committed window becomes the Context window (one history entry, as the brush); a committed value
 * range is this component's pin, passed back to the engine in the spec (`valueRange`) until it is
 * reset (Reset Y axis, a fit commit), the kind or unit changes, or the chart unmounts.
 *
 * Threshold labels (#64 Part B §3.9.1, ADR-0022): every label the engine truncated or gathered into
 * an overflow chip gets a focusable target over the canvas, at least 24 × 24 px (T08-010), whose
 * tooltip and accessible name are the full text; the summary label lists every threshold.
 *
 * Event markers (#64 Part C §3.7, ADR-0023): the caller's `events` go to the engine, which draws
 * them and reports each label box; every box gets a focusable target over the canvas, at least
 * 24 × 24 px and kept inside the frame (T08-010), whose tooltip and accessible name list its events
 * with their kind and time; the summary label counts the events in view.
 *
 * Bar chart (ADR-0028, ADR-0029, plan #173 Part 2 §4.4, Part 3a §3.2): no crosshair slider; the key
 * target is the mirror listbox (`BarList`), whose active option follows a keyboard `mark` and whose
 * options are selected from the page selection. The engine's `mark` shows `MarkTooltip` beside the
 * bar, with the caller's `markLines`; its `pick` goes to `onPick` with the listbox as the focus to
 * return to; the summary label counts the bars. The coverage meter (`CategoryChart`) replaces the
 * truncation notice.
 *
 * Readiness (#90, ADR-0019): the caller's `pending` shows over the frame until the engine reports,
 * with `drawn`, a complete draw at the size last applied; every resize, kind change and new frame
 * resets it. A new `fill` frame is sized at once from the caller's `sizeMemo` (the host's last
 * non-empty size), so a re-created frame draws in its first animation frame.
 */
import {
  useContext,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { Focusable } from 'react-aria-components';
import { emptyFrameData, validateFrameData } from '../data/frames';
import type {
  CategoryRow,
  ChartFrame as EngineFrame,
  EventMarker,
  FrameData,
  FrameSummary,
  HoverEvent,
  MarkEvent,
  PickEvent,
  PlotRect,
  TimeWindow,
  ValueRange,
  VisSpec,
} from '../engine/api';
import { ChartUnsupportedError } from '../engine/canvas2d/Canvas2DEngine';
import { ChartEngineContext } from '../engine/index';
import { t } from '../i18n/t';
import { useSelection } from '../inspector/host';
import type { InspectorTarget } from '../inspector/types';
import { Button } from '../kit/Button';
import { cx } from '../kit/cx';
import { Tooltip } from '../kit/Tooltip';
import { printTimeExpr } from '../state/timeExpr';
import { useTimeZone } from '../state/timeZone';
import { useTimeContext } from '../state/useTimeContext';
import { size, space } from '../styles/tokens';
import { useResolvedTheme } from '../theme/useResolvedTheme';
import stateStyles from '../theme/stateEncoding.module.css';
import styles from './ChartFrame.module.css';
import { ChartTooltip } from './ChartTooltip';
import { BarList } from './BarList';
import { MarkTooltip } from './MarkTooltip';
import { useWheelHint } from './WheelHint';
import {
  crosshairText,
  eventText,
  issueText,
  sortedRows,
  summaryLabel,
  tooltipLeft,
  valueUnit,
} from './chartText';
import { geoTooltip, hoverItemOf, statTarget, targetOf } from './inspectTarget';

/** The geomap tooltip's offset from the pointer, CSS px. */
const GEO_TIP_GAP = 12;

/** `min,max,manual|auto` of the drawn value axis (#173 Part 3b §3.1); none without one. */
function valueAxisAttr(s: FrameSummary | null): string | undefined {
  const a = s?.valueAxis ?? null;
  return a === null
    ? undefined
    : `${String(a.min)},${String(a.max)},${a.manual ? 'manual' : 'auto'}`;
}

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface ChartFrameProps {
  readonly spec: VisSpec;
  readonly data: FrameData;
  /** Fill the parent's height (board panels, full screen) instead of the fixed chart height. */
  readonly fill?: boolean;
  /** Shown over the frame until the engine has drawn it at its current size (#90). */
  readonly pending?: ReactNode;
  /** The host's last non-empty observed size, kept by the caller across unmounts (#90). */
  readonly sizeMemo?: { current: FrameSize | null };
  /** Event markers on the time axis (ADR-0023); absent = none. */
  readonly events?: readonly EventMarker[];
  /**
   * A click on a mark or Enter/Space on the crosshair (T25-005): the target, how it was chosen and
   * where focus returns when the Inspector closes. Absent without an Inspector host.
   */
  readonly onInspect?: (
    t: InspectorTarget,
    source: 'pointer' | 'keyboard',
    returnFocus: HTMLElement | null,
  ) => void;
  /** A click on the plot with no mark under it: clears the selection (T25 §4.2). */
  readonly onEmptyClick?: () => void;
  /** Barchart: a click on a bar or on no bar, or a brush (ADR-0028, ADR-0029). */
  readonly onPick?: (e: PickEvent, returnFocus: HTMLElement | null) => void;
  /** Barchart: the tooltip's lines for a row (plan #173 Part 3a §3.5); absent = none. */
  readonly markLines?: (row: CategoryRow) => readonly string[];
  /**
   * The engine frame after it is created, and null before it is disposed (ADR-0027; plan #234
   * Part 3 §3.2): the geomap host subscribes to its geo events.
   */
  readonly onFrame?: (f: EngineFrame | null) => void;
  /** Each a11y summary, after this frame's own state (plan #234 Part 3 §4.4a). */
  readonly onSummary?: (s: FrameSummary) => void;
  /** `geo`: the host div is the map's plot surface and key target (T24 §5.14); default `chart`. */
  readonly surface?: 'chart' | 'geo';
  /** Spans of held data not fresh for the view (#304 §4.3): hatched over the plot. */
  readonly stale?: readonly TimeWindow[];
}

interface HoverState {
  readonly hover: HoverEvent | null;
  /** The selected row of `sortedRows` (keyboard). */
  readonly selected: number;
}

/** The value-axis pin (#93) and the kind and unit it was made for. */
interface Pin {
  readonly key: string;
  readonly range: ValueRange;
}

const px = (n: number): string => `${String(n)}px`;

/** No events: one frozen value, so an absent prop never changes. */
const NO_MARKERS: readonly EventMarker[] = Object.freeze([]);

/**
 * A held span not fresh for the view (#304 §4.3, PRF-026's subtle hatching): its part of the plot,
 * from the latest summary's plot and window, placed through CSSOM (no inline styles, T01-010).
 */
function StaleSpan({ box }: { box: PlotRect }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.left = px(box.x);
    el.style.top = px(box.y);
    el.style.width = px(box.width);
    el.style.height = px(box.height);
  }, [box]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-stale-span=""
      className={cx(styles['stale'], stateStyles['staleHatch'])}
    />
  );
}

/** Each stale span clipped to the plot, as boxes; [] without a summary. */
function staleBoxes(s: FrameSummary | null, spans: readonly TimeWindow[]): PlotRect[] {
  if (s === null || spans.length === 0 || !(s.toMs > s.fromMs)) return [];
  const x = (t: number): number => s.plot.x + ((t - s.fromMs) / (s.toMs - s.fromMs)) * s.plot.width;
  const out: PlotRect[] = [];
  for (const w of spans) {
    const x0 = x(Math.max(w.fromMs, s.fromMs));
    const x1 = x(Math.min(w.toMs, s.toMs));
    if (x1 > x0) out.push({ x: x0, y: s.plot.y, width: x1 - x0, height: s.plot.height });
  }
  return out;
}

/** `prefers-reduced-motion: reduce` (VL-016): a data transition becomes an instant cut. */
function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const NO_STALE: readonly TimeWindow[] = Object.freeze([]);

/**
 * The focusable target over a clipped threshold label: its tooltip and accessible name are the
 * full text. Placed through CSSOM (no inline styles: CSP style-src, T01-010).
 */
function ThresholdHit({ box, text }: { box: PlotRect; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const r = hitRect(box);
    el.style.left = px(r.x);
    el.style.top = px(r.y);
    el.style.width = px(r.width);
    el.style.height = px(r.height);
  }, [box]);
  return (
    <Tooltip label={text}>
      <Focusable>
        <span
          ref={ref}
          // A clipped label's full text, by keyboard (T08-010).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="img"
          aria-label={text}
          data-threshold-hit=""
          className={cx(styles['thresholdHit'])}
        />
      </Focusable>
    </Tooltip>
  );
}

/**
 * The focusable target over an event label box (ADR-0023): its tooltip and accessible name are
 * every event in the box. At least the minimum target size and kept inside the frame (`host`), so
 * a box without text at a plot edge stays reachable (T08-010). Placed through CSSOM.
 */
function EventHit({
  box,
  x,
  text,
  host,
}: {
  box: PlotRect;
  x: number;
  text: string;
  host: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const r = hitRect(box);
    const w = host.current?.clientWidth ?? 0;
    const h = host.current?.clientHeight ?? 0;
    const left = w > 0 ? Math.min(Math.max(0, r.x), Math.max(0, w - r.width)) : r.x;
    const top = h > 0 ? Math.min(Math.max(0, r.y), Math.max(0, h - r.height)) : r.y;
    el.style.left = px(left);
    el.style.top = px(top);
    el.style.width = px(r.width);
    el.style.height = px(r.height);
  }, [box, host]);
  return (
    <Tooltip label={text}>
      <Focusable>
        <span
          ref={ref}
          // The events of a marker label, by keyboard (T08-010).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="img"
          aria-label={text}
          data-event-hit=""
          data-event-x={x}
          className={cx(styles['eventHit'])}
        />
      </Focusable>
    </Tooltip>
  );
}

/** A threshold label's box grown to at least the minimum target size about its centre (T08-010). */
function hitRect(b: PlotRect): PlotRect {
  const width = Math.max(b.width, size['target-min']);
  const height = Math.max(b.height, size['target-min']);
  return {
    x: b.x + b.width / 2 - width / 2,
    y: b.y + b.height / 2 - height / 2,
    width,
    height,
  };
}

/** Diagnostic frame ids (`f1`, `f2`, …): `data-frame-id` and the `chart-draw` measures' `frame`. */
let frameSeq = 0;

export function ChartFrame({
  spec,
  data,
  fill = false,
  pending,
  sizeMemo,
  events = NO_MARKERS,
  onInspect,
  onEmptyClick,
  onPick,
  markLines,
  onFrame,
  onSummary,
  stale = NO_STALE,
  surface = 'chart',
}: ChartFrameProps) {
  const engine = useContext(ChartEngineContext);
  const { window: win, dispatch } = useTimeContext();
  const tz = useTimeZone();
  const theme = useResolvedTheme();
  const issue = useMemo(() => validateFrameData(spec, data), [spec, data]);
  const frameData = useMemo(() => {
    if (issue !== null) return emptyFrameData(spec);
    // ADR-0039: under reduced motion the crossfade is stripped before the engine sees it.
    if (data.kind === 'series' && data.transition !== undefined && reducedMotion()) {
      const cut: FrameData = {
        kind: 'series',
        series: data.series,
        ...(data.fit === undefined ? {} : { fit: data.fit }),
      };
      return cut;
    }
    return data;
  }, [issue, data, spec]);
  const { fromMs, toMs } = win;
  const isStat = spec.kind === 'stat';
  // A bar chart has no crosshair: its bars report `mark` and `pick` (ADR-0028).
  const isBar = spec.kind === 'barchart';
  // A geomap's host div is its plot surface and key target (T24 §5.14): no crosshair or label targets.
  const isGeo = surface === 'geo';
  const noCrosshair = isStat || isBar || isGeo;

  // The value-axis pin (#93): a kind or unit change drops it. Clearing it during render (React's
  // "adjust state during render") re-runs the render with no pin before any effect or paint, so a
  // later return to the old kind or unit starts unpinned.
  const pinKey = `${spec.kind}|${JSON.stringify(spec.unit)}`;
  const [pin, setPin] = useState<Pin | null>(null);
  if (pin !== null && pin.key !== pinKey) setPin(null);
  const valueRange = pin !== null && pin.key === pinKey ? pin.range : null;
  const engineSpec = useMemo<VisSpec>(
    () =>
      valueRange !== null && (spec.kind === 'line' || spec.kind === 'bars')
        ? { ...spec, valueRange }
        : spec,
    [spec, valueRange],
  );

  const hostRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<EngineFrame | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The latest inputs, for the mount effect and the event callbacks (not effect dependencies).
  const latest = useRef({
    spec,
    engineSpec,
    pinKey,
    frameData,
    fromMs,
    toMs,
    theme,
    dispatch,
    tz,
    events,
    onInspect,
    onEmptyClick,
    onPick,
    onFrame,
    onSummary,
  });
  useLayoutEffect(() => {
    latest.current = {
      spec,
      engineSpec,
      pinKey,
      frameData,
      fromMs,
      toMs,
      theme,
      dispatch,
      tz,
      events,
      onInspect,
      onEmptyClick,
      onPick,
      onFrame,
      onSummary,
    };
  });
  // The page selection (T25-006): every frame draws it, the source included.
  const selection = useSelection();
  const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const selectedKeys = useMemo(() => new Set(selection?.keys ?? []), [selection]);

  const [summary, setSummary] = useState<FrameSummary | null>(null);
  const [{ hover, selected }, setHoverState] = useState<HoverState>({ hover: null, selected: 0 });
  const [mark, setMark] = useState<MarkEvent | null>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const geoTipRef = useRef<HTMLDivElement>(null);
  const barListId = useId();
  const [unsupported, setUnsupported] = useState(false);
  const wheelHint = useWheelHint();
  const showWheelHint = wheelHint.show;
  const ownSize = useRef<FrameSize | null>(null);
  const memo = sizeMemo ?? ownSize;
  // Drawn at its current size: `pending` hides. The ref skips redundant updates (hover redraws).
  const [drawn, setDrawn] = useState(false);
  const drawnRef = useRef(false);
  const kindRef = useRef(spec.kind);
  /** The selection for a frame created later (the mount effect reads it). */
  const selectionRef = useRef(selection);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const id = `f${String(++frameSeq)}`;
    host.dataset['frameId'] = id;
    const canvas = document.createElement('canvas');
    canvas.className = cx(styles['canvas']);
    if (isGeo) {
      // The surface (the host div) carries the map's name; the list reads its marks (T24-093).
      canvas.setAttribute('aria-hidden', 'true');
    } else {
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', latest.current.spec.title);
    }
    host.insertBefore(canvas, host.firstChild);
    canvasRef.current = canvas;
    let frame: EngineFrame;
    try {
      frame = engine.createFrame(canvas, {
        timeZone: tz,
        keyTarget: isGeo ? host : isBar ? listRef.current : isStat ? null : sliderRef.current,
        id,
      });
    } catch (e) {
      canvas.remove();
      delete host.dataset['frameId'];
      if (!(e instanceof ChartUnsupportedError)) throw e;
      // Only trying to create the frame reveals a missing 2D context; the notice follows it.
      queueMicrotask(() => {
        setUnsupported(true);
      });
      return;
    }
    frameRef.current = frame;
    let size = { width: 0, height: 0 };
    let applied = false;
    /**
     * `sync`: from the observer, the DPR callback or the engine's frame callback, outside React's
     * commit, so the change shows before this frame's paint.
     */
    const setDrawnTo = (v: boolean, sync: boolean): void => {
      if (drawnRef.current === v) return;
      drawnRef.current = v;
      if (sync) {
        flushSync(() => {
          setDrawn(v);
        });
      } else {
        setDrawn(v);
      }
    };
    const resize = (sync: boolean): void => {
      applied = true;
      // Setting the canvas size clears it, 0 × 0 included.
      setDrawnTo(false, sync);
      frame.resize(size.width, size.height, globalThis.devicePixelRatio);
    };
    const offs = [
      frame.on('a11y', (s) => {
        setSummary(s);
        latest.current.onSummary?.(s);
      }),
      frame.on('hover', (h) => {
        setHoverState({ hover: h, selected: 0 });
      }),
      frame.on('mark', (m) => {
        setMark(m);
      }),
      frame.on('wheelHint', () => {
        showWheelHint();
      }),
      frame.on('pick', (e) => {
        latest.current.onPick?.(e, listRef.current);
      }),
      frame.on('brush', (b) => {
        const d = latest.current.dispatch;
        if (b.gesture === 'zoomOut') {
          d({ type: 'zoom', dir: 'out' });
          return;
        }
        d({
          type: 'setRange',
          from: printTimeExpr({ kind: 'absolute', ms: b.fromMs }),
          to: printTimeExpr({ kind: 'absolute', ms: b.toMs }),
        });
      }),
      frame.on('commit', (c) => {
        const l = latest.current;
        // A time move is one push, as the brush (T03-016); every chart on the page follows it.
        if (c.window !== null) {
          l.dispatch({
            type: 'setRange',
            from: printTimeExpr({ kind: 'absolute', ms: c.window.fromMs }),
            to: printTimeExpr({ kind: 'absolute', ms: c.window.toMs }),
          });
        }
        // A time-only commit (`value === null`) leaves the pin as it is.
        if (c.value !== null) setPin(c.value === 'auto' ? null : { key: l.pinKey, range: c.value });
      }),
      frame.on('select', (e) => {
        // T25-005: a click on a mark inspects it; an empty click clears the selection.
        const l = latest.current;
        if (e.item === null) {
          l.onEmptyClick?.();
          return;
        }
        // A geomap mark returns focus to the map's surface (T24-092).
        const back = e.item.kind === 'geo' ? hostRef.current : sliderRef.current;
        l.onInspect?.(targetOf(l.spec, l.frameData, e.item), e.source, back);
      }),
      frame.on('drawn', (d) => {
        // A draw at a superseded size leaves the progress up.
        if (d.cssWidth !== size.width || d.cssHeight !== size.height) return;
        // In the engine's frame callback: hides `pending` before this frame's paint.
        setDrawnTo(true, true);
      }),
    ];
    const l = latest.current;
    frame.setSpec(l.engineSpec);
    frame.setData(l.frameData);
    frame.setTimeWindow({ fromMs: l.fromMs, toMs: l.toMs });
    frame.setTheme(l.theme);
    frame.setEvents(l.events);
    frame.setSelection(selectionRef.current);
    l.onFrame?.(frame);
    // A new canvas is blank.
    setDrawnTo(false, false);
    // A new fill frame takes the host's last size at once, so it draws in its first frame.
    if (fill && memo.current !== null) {
      size = memo.current;
      resize(false);
    }

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r === undefined) return;
      if (r.width > 0 && r.height > 0) memo.current = { width: r.width, height: r.height };
      // Re-applying an equal size would clear the canvas drawn in this frame.
      if (applied && r.width === size.width && r.height === size.height) return;
      size = { width: r.width, height: r.height };
      resize(true);
    });
    ro.observe(host);
    // A DPR change (zoom, another screen) does not resize the host: watch the resolution query.
    let mql: MediaQueryList | null = null;
    const onDpr = (): void => {
      resize(true);
      watchDpr();
    };
    const watchDpr = (): void => {
      mql?.removeEventListener('change', onDpr);
      try {
        mql = globalThis.matchMedia(`(resolution: ${String(globalThis.devicePixelRatio)}dppx)`);
        mql.addEventListener('change', onDpr);
      } catch {
        mql = null; // No matchMedia: DPR changes are picked up on the next resize.
      }
    };
    watchDpr();

    return () => {
      latest.current.onFrame?.(null);
      for (const off of offs) off();
      ro.disconnect();
      mql?.removeEventListener('change', onDpr);
      frame.dispose();
      canvas.remove();
      delete host.dataset['frameId'];
      frameRef.current = null;
      canvasRef.current = null;
      setDrawnTo(false, false);
    };
  }, [engine, tz, noCrosshair, isBar, isStat, isGeo, fill, memo, showWheelHint]);

  useEffect(() => {
    // A kind change on a kept frame clears its canvas (the engine), so it is not drawn.
    if (kindRef.current !== engineSpec.kind) {
      drawnRef.current = false;
      setDrawn(false);
    }
    kindRef.current = engineSpec.kind;
    frameRef.current?.setSpec(engineSpec);
  }, [engineSpec]);
  useEffect(() => {
    frameRef.current?.setData(frameData);
  }, [frameData]);
  useEffect(() => {
    frameRef.current?.setTimeWindow({ fromMs, toMs });
  }, [fromMs, toMs]);
  useEffect(() => {
    frameRef.current?.setTheme(theme);
  }, [theme]);
  useEffect(() => {
    frameRef.current?.setEvents(events);
  }, [events]);
  useEffect(() => {
    selectionRef.current = selection;
    frameRef.current?.setSelection(selection);
  }, [selection]);

  // The summary label follows the spec (title, unit, kind) and the zone as well as the summary: the
  // engine emits `a11y` only when the numbers change.
  useEffect(() => {
    if (isGeo) return;
    canvasRef.current?.setAttribute(
      'aria-label',
      summary === null ? spec.title : summaryLabel(spec, summary, tz),
    );
    // A bar chart's bars, by name and value, for assistive technology (T22-013 subset, VIZ-068).
    if (isBar) canvasRef.current?.setAttribute('aria-describedby', barListId);
    else canvasRef.current?.removeAttribute('aria-describedby');
  }, [spec, summary, tz, engine, isStat, isBar, isGeo, barListId]);

  // Tooltip beside the crosshair, flipped left at the host's right edge (CSSOM, T18-004).
  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    const host = hostRef.current;
    if (tip === null || host === null || hover === null) return;
    const left = tooltipLeft(hover.xCss, tip.offsetWidth, host.clientWidth);
    tip.style.translate = `${px(left)} ${px(summary?.plot.y ?? 0)}`;
  }, [hover, summary, selected]);

  // The geomap's tooltip beside the hovered mark, flipped at the edges (CSSOM, T18-004).
  useLayoutEffect(() => {
    const tip = geoTipRef.current;
    const host = hostRef.current;
    if (tip === null || host === null || hover === null || !isGeo) return;
    const left = tooltipLeft(hover.xCss, tip.offsetWidth, host.clientWidth);
    const below = hover.yCss + GEO_TIP_GAP;
    const top =
      host.clientHeight > 0 && below + tip.offsetHeight > host.clientHeight
        ? Math.max(0, hover.yCss - GEO_TIP_GAP - tip.offsetHeight)
        : below;
    tip.style.translate = `${px(left)} ${px(top)}`;
  }, [hover, isGeo]);

  // The bar chart's tooltip beside the marked bar, centred on its band (CSSOM, T18-004).
  useLayoutEffect(() => {
    const tip = markRef.current;
    const host = hostRef.current;
    if (tip === null || host === null || mark === null) return;
    const left = tooltipLeft(mark.xCss, tip.offsetWidth, host.clientWidth);
    tip.style.translate = `${px(left)} ${px(Math.max(0, mark.yCss - tip.offsetHeight / 2))}`;
  }, [mark]);

  // The crosshair slider covers the plot; pointer input passes through to the canvas.
  useLayoutEffect(() => {
    const s = sliderRef.current;
    if (s === null || summary === null) return;
    const p = summary.plot;
    s.style.left = px(p.x);
    s.style.top = px(p.y);
    s.style.width = px(Math.max(0, p.width));
    s.style.height = px(Math.max(0, p.height));
  }, [summary]);

  // The Reset Y axis button over the plot's top-left corner (CSSOM, T08-023).
  useLayoutEffect(() => {
    const b = resetRef.current;
    if (b === null || summary === null) return;
    b.style.translate = `${px(summary.plot.x + space['1'])} ${px(summary.plot.y + space['1'])}`;
  }, [summary, valueRange]);

  const onSliderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Escape clears an active crosshair (the engine does that) and goes no further, so a dialog
    // around the chart closes only on the next Escape.
    if (e.key === 'Escape') {
      if (hover !== null) e.stopPropagation();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && onInspect !== undefined) {
      // T25-005: the keyboard crosshair's selected row is inspected.
      const row = hover?.source === 'keyboard' ? sortedRows(hover.rows)[selected] : undefined;
      if (hover === null || hover.tMs === null || row === undefined) return;
      e.preventDefault();
      const item = hoverItemOf(spec, frameData, { ...hover, tMs: hover.tMs }, row, toMs);
      onInspect(targetOf(spec, frameData, item), 'keyboard', e.currentTarget);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const n = hover?.rows.length ?? 0;
    const step = e.key === 'ArrowUp' ? -1 : 1;
    setHoverState((s) => ({
      ...s,
      selected: Math.min(Math.max(0, n - 1), Math.max(0, s.selected + step)),
    }));
  };

  const plot = summary?.plot ?? null;
  const geoItem = isGeo && hover !== null && 'item' in hover ? hover.item : null;
  const geoLines =
    geoItem === null || frameData.kind !== 'geo'
      ? []
      : geoTooltip(frameData.geo, geoItem, spec.unit);
  const markRow =
    mark === null || frameData.kind !== 'categories'
      ? undefined
      : frameData.categories.find((r) => r.key === mark.key);
  return (
    <div
      ref={hostRef}
      className={cx(
        styles['frame'],
        fill ? styles['fill'] : isStat ? styles['stat'] : styles['chart'],
        isBar ? styles['barFrame'] : undefined,
      )}
      data-chart-frame=""
      data-frame-ready={summary === null ? 'false' : 'true'}
      data-selection-keys={selection === null ? '' : selection.keys.join(',')}
      data-plot={plot === null ? undefined : [plot.x, plot.y, plot.width, plot.height].join(',')}
      data-value-axis={valueAxisAttr(summary)}
      {...(isGeo
        ? {
            // The map's plot surface: the engine's camera keys land here (T24-091).
            tabIndex: 0,
            role: 'application',
            'aria-roledescription': t('geo.surface.role'),
            'aria-label': spec.title,
            'data-surface': 'geo',
          }
        : {})}
    >
      {!noCrosshair && (
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          className={cx(styles['crosshair'])}
          aria-label={t('chart.crosshair', { title: spec.title })}
          aria-valuemin={summary?.fromMs ?? fromMs}
          aria-valuemax={summary?.toMs ?? toMs}
          aria-valuenow={hover?.tMs ?? summary?.toMs ?? toMs}
          aria-valuetext={crosshairText(spec, hover, tz, selected)}
          onKeyDown={onSliderKey}
        />
      )}
      {isStat && onInspect !== undefined && (
        <button
          type="button"
          className={cx(styles['inspect'])}
          aria-label={t('inspector.inspect', { title: spec.title })}
          onClick={(e) => {
            onInspect(
              statTarget(spec, frameData),
              e.detail === 0 ? 'keyboard' : 'pointer',
              e.currentTarget,
            );
          }}
        />
      )}
      {isBar && frameData.kind === 'categories' && (
        <BarList
          ref={listRef}
          id={barListId}
          spec={spec}
          data={frameData}
          active={mark?.source === 'keyboard' ? mark.index : null}
          selected={selectedKeys}
        />
      )}
      {isBar && (
        <MarkTooltip
          ref={markRef}
          mark={mark}
          row={markRow}
          unit={spec.unit}
          ghost={spec.ghost}
          {...(markLines === undefined || markRow === undefined
            ? {}
            : { lines: markLines(markRow) })}
        />
      )}
      {!noCrosshair && (
        <ChartTooltip
          ref={tooltipRef}
          hover={hover}
          selected={selected}
          plot={plot}
          unit={valueUnit(spec)}
          timeZone={tz}
        />
      )}
      {isGeo && (
        <div
          ref={geoTipRef}
          className={cx(styles['tooltip'])}
          data-chart-tooltip=""
          aria-hidden="true"
          hidden={geoLines.length === 0}
        >
          {geoLines.map((line, i) => (
            <div key={`${String(i)}:${line}`} className={cx(styles['row'])} data-tooltip-line="">
              {line}
            </div>
          ))}
        </div>
      )}
      {spec.kind === 'line' &&
        staleBoxes(summary, stale).map((b) => (
          <StaleSpan key={`${String(b.x)}:${String(b.width)}`} box={b} />
        ))}
      {!isStat &&
        !isGeo &&
        (summary?.thresholdLabels ?? [])
          .filter((b) => b.clipped)
          .map((b) => (
            <ThresholdHit key={`${String(b.box.x)},${String(b.box.y)}`} box={b.box} text={b.text} />
          ))}
      {!isStat &&
        !isGeo &&
        (summary?.eventLabels ?? []).map((b) => (
          <EventHit
            key={b.ids.join(',')}
            box={b.box}
            x={b.x}
            text={eventText(b.ids, eventsById, tz)}
            host={hostRef}
          />
        ))}
      {valueRange !== null && (
        // The kit Button takes no ref, so its wrapper is the placed element.
        <div ref={resetRef} className={cx(styles['resetValue'])}>
          <Button
            variant="secondary"
            aria-label={t('chart.valueAxis.resetLabel', { title: spec.title })}
            onPress={() => {
              setPin(null);
              sliderRef.current?.focus();
            }}
          >
            {t('chart.valueAxis.reset')}
          </Button>
        </div>
      )}
      {!isBar && !isGeo && summary !== null && summary.seriesShown < summary.seriesTotal && (
        <p className={cx(styles['notice'])} role="status">
          {t('chart.truncated', { shown: summary.seriesShown, total: summary.seriesTotal })}
        </p>
      )}
      {issue !== null && (
        <p className={cx(styles['notice'])}>{t('chart.invalid', { reason: issueText(issue) })}</p>
      )}
      {unsupported && <p className={cx(styles['notice'])}>{t('chart.unsupported')}</p>}
      {!isStat && !isGeo && !isBar && wheelHint.hint}
      {pending !== undefined && !drawn && !unsupported && (
        <div className={cx(styles['pending'])} data-chart-pending="">
          {pending}
        </div>
      )}
    </div>
  );
}
