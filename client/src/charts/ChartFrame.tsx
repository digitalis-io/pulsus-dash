/**
 * `<ChartFrame>`: one chart on one `<canvas>`, drawn by the engine behind the ADR-0014 §3 seam
 * (plan #58 §4.2). The component owns the semantic side: the Context (brush → URL), validation,
 * the DOM tooltip, the notices, the summary label and the keyboard crosshair slider. The engine
 * owns scales, marks, picking and the brush gesture. The canvas is created for the frame's lifetime,
 * so a later `transferControlToOffscreen()` (#68) survives StrictMode re-mounts.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { emptyFrameData, validateFrameData } from '../data/frames';
import type {
  ChartFrame as EngineFrame,
  FrameData,
  FrameSummary,
  HoverEvent,
  VisSpec,
} from '../engine/api';
import { ChartUnsupportedError } from '../engine/canvas2d/Canvas2DEngine';
import { ChartEngineContext } from '../engine/index';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { printTimeExpr } from '../state/timeExpr';
import { useTimeZone } from '../state/timeZone';
import { useTimeContext } from '../state/useTimeContext';
import { space } from '../styles/tokens';
import { useResolvedTheme } from '../theme/useResolvedTheme';
import styles from './ChartFrame.module.css';
import { ChartTooltip } from './ChartTooltip';
import { crosshairText, issueText, summaryLabel, valueUnit } from './chartText';

export interface ChartFrameProps {
  readonly spec: VisSpec;
  readonly data: FrameData;
  /** Fill the parent's height (board panels, full screen) instead of the fixed chart height. */
  readonly fill?: boolean;
}

interface HoverState {
  readonly hover: HoverEvent | null;
  /** The selected row of `sortedRows` (keyboard). */
  readonly selected: number;
}

const px = (n: number): string => `${String(n)}px`;

export function ChartFrame({ spec, data, fill = false }: ChartFrameProps) {
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

  const hostRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<EngineFrame | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The latest inputs, for the mount effect and the event callbacks (not effect dependencies).
  const latest = useRef({ spec, frameData, fromMs, toMs, theme, dispatch, tz });
  useLayoutEffect(() => {
    latest.current = { spec, frameData, fromMs, toMs, theme, dispatch, tz };
  });

  const [summary, setSummary] = useState<FrameSummary | null>(null);
  const [{ hover, selected }, setHoverState] = useState<HoverState>({ hover: null, selected: 0 });
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
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
      });
    } catch (e) {
      canvas.remove();
      if (!(e instanceof ChartUnsupportedError)) throw e;
      // Only trying to create the frame reveals a missing 2D context; the notice follows it.
      queueMicrotask(() => {
        setUnsupported(true);
      });
      return;
    }
    frameRef.current = frame;
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
    ];
    const l = latest.current;
    frame.setSpec(l.spec);
    frame.setData(l.frameData);
    frame.setTimeWindow({ fromMs: l.fromMs, toMs: l.toMs });
    frame.setTheme(l.theme);

    let size = { width: 0, height: 0 };
    const resize = (): void => {
      frame.resize(size.width, size.height, globalThis.devicePixelRatio);
    };
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r === undefined) return;
      size = { width: r.width, height: r.height };
      resize();
    });
    ro.observe(host);
    // A DPR change (zoom, another screen) does not resize the host: watch the resolution query.
    let mql: MediaQueryList | null = null;
    const onDpr = (): void => {
      resize();
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
      frameRef.current = null;
      canvasRef.current = null;
    };
  }, [engine, tz, isStat]);

  useEffect(() => {
    frameRef.current?.setSpec(spec);
  }, [spec]);
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

  const onSliderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
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
      {summary !== null && summary.seriesShown < summary.seriesTotal && (
        <p className={cx(styles['notice'])} role="status">
          {t('chart.truncated', { shown: summary.seriesShown, total: summary.seriesTotal })}
        </p>
      )}
      {issue !== null && (
        <p className={cx(styles['notice'])}>{t('chart.invalid', { reason: issueText(issue) })}</p>
      )}
      {unsupported && <p className={cx(styles['notice'])}>{t('chart.unsupported')}</p>}
    </div>
  );
}
