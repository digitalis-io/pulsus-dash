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
 * Readiness (#90, ADR-0019): the caller's `pending` shows over the frame until the engine reports,
 * with `drawn`, a complete draw at the size last applied; every resize, kind change and new frame
 * resets it. A new `fill` frame is sized at once from the caller's `sizeMemo` (the host's last
 * non-empty size), so a re-created frame draws in its first animation frame.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { Focusable } from 'react-aria-components';
import { emptyFrameData, validateFrameData } from '../data/frames';
import type {
  ChartFrame as EngineFrame,
  EventMarker,
  FrameData,
  FrameSummary,
  HoverEvent,
  PlotRect,
  ValueRange,
  VisSpec,
} from '../engine/api';
import { ChartUnsupportedError } from '../engine/canvas2d/Canvas2DEngine';
import { ChartEngineContext } from '../engine/index';
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { cx } from '../kit/cx';
import { Tooltip } from '../kit/Tooltip';
import { printTimeExpr } from '../state/timeExpr';
import { useTimeZone } from '../state/timeZone';
import { useTimeContext } from '../state/useTimeContext';
import { size, space } from '../styles/tokens';
import { useResolvedTheme } from '../theme/useResolvedTheme';
import styles from './ChartFrame.module.css';
import { ChartTooltip } from './ChartTooltip';
import { crosshairText, issueText, summaryLabel, valueUnit } from './chartText';

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

export function ChartFrame({ spec, data, fill = false, pending, sizeMemo }: ChartFrameProps) {
  const engine = useContext(ChartEngineContext);
  const { window: win, dispatch } = useTimeContext();
  const tz = useTimeZone();
  const theme = useResolvedTheme();
  const issue = useMemo(() => validateFrameData(spec, data), [spec, data]);
  const frameData = useMemo(
    () => (issue === null ? data : emptyFrameData(spec)),
    [issue, data, spec],
  );
  const { fromMs, toMs } = win;
  const isStat = spec.kind === 'stat';

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
  const tooltipRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<EngineFrame | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The latest inputs, for the mount effect and the event callbacks (not effect dependencies).
  const latest = useRef({ spec, engineSpec, pinKey, frameData, fromMs, toMs, theme, dispatch, tz });
  useLayoutEffect(() => {
    latest.current = { spec, engineSpec, pinKey, frameData, fromMs, toMs, theme, dispatch, tz };
  });

  const [summary, setSummary] = useState<FrameSummary | null>(null);
  const [{ hover, selected }, setHoverState] = useState<HoverState>({ hover: null, selected: 0 });
  const [unsupported, setUnsupported] = useState(false);
  const ownSize = useRef<FrameSize | null>(null);
  const memo = sizeMemo ?? ownSize;
  // Drawn at its current size: `pending` hides. The ref skips redundant updates (hover redraws).
  const [drawn, setDrawn] = useState(false);
  const drawnRef = useRef(false);
  const kindRef = useRef(spec.kind);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const id = `f${String(++frameSeq)}`;
    host.dataset['frameId'] = id;
    const canvas = document.createElement('canvas');
    canvas.className = cx(styles['canvas']);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', latest.current.spec.title);
    host.insertBefore(canvas, host.firstChild);
    canvasRef.current = canvas;
    let frame: EngineFrame;
    try {
      frame = engine.createFrame(canvas, {
        timeZone: tz,
        keyTarget: isStat ? null : sliderRef.current,
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
      }),
      frame.on('hover', (h) => {
        setHoverState({ hover: h, selected: 0 });
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
  }, [engine, tz, isStat, fill, memo]);

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

  // The summary label follows the spec (title, unit, kind) and the zone as well as the summary: the
  // engine emits `a11y` only when the numbers change.
  useEffect(() => {
    canvasRef.current?.setAttribute(
      'aria-label',
      summary === null ? spec.title : summaryLabel(spec, summary, tz),
    );
  }, [spec, summary, tz, engine, isStat]);

  // Tooltip beside the crosshair, flipped left at the host's right edge (CSSOM, T18-004).
  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    const host = hostRef.current;
    if (tip === null || host === null || hover === null) return;
    const width = tip.offsetWidth;
    let left = hover.xCss + space['3'];
    if (left + width > host.clientWidth) left = hover.xCss - space['3'] - width;
    tip.style.translate = `${px(left)} ${px(summary?.plot.y ?? 0)}`;
  }, [hover, summary, selected]);

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
  return (
    <div
      ref={hostRef}
      className={cx(
        styles['frame'],
        fill ? styles['fill'] : isStat ? styles['stat'] : styles['chart'],
      )}
      data-chart-frame=""
      data-frame-ready={summary === null ? 'false' : 'true'}
      data-plot={plot === null ? undefined : [plot.x, plot.y, plot.width, plot.height].join(',')}
    >
      {!isStat && (
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
      {!isStat && (
        <ChartTooltip
          ref={tooltipRef}
          hover={hover}
          selected={selected}
          plot={plot}
          unit={valueUnit(spec)}
          timeZone={tz}
        />
      )}
      {!isStat &&
        (summary?.thresholdLabels ?? [])
          .filter((b) => b.clipped)
          .map((b) => (
            <ThresholdHit key={`${String(b.box.x)},${String(b.box.y)}`} box={b.box} text={b.text} />
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
      {summary !== null && summary.seriesShown < summary.seriesTotal && (
        <p className={cx(styles['notice'])} role="status">
          {t('chart.truncated', { shown: summary.seriesShown, total: summary.seriesTotal })}
        </p>
      )}
      {issue !== null && (
        <p className={cx(styles['notice'])}>{t('chart.invalid', { reason: issueText(issue) })}</p>
      )}
      {unsupported && <p className={cx(styles['notice'])}>{t('chart.unsupported')}</p>}
      {pending !== undefined && !drawn && !unsupported && (
        <div className={cx(styles['pending'])} data-chart-pending="">
          {pending}
        </div>
      )}
    </div>
  );
}
