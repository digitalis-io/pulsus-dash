/**
 * A bar chart in a measured cell (plan #173 Part 2 §4.1, §4.4; ADR-0028). The cell's size (whole CSS
 * px; the caller's `sizeMemo` first, so a re-mounted chart fits at once) goes through
 * `fitBarchart` with an offscreen measure in the axis font. The fit mounts a `ChartFrame`, or shows
 * the `tooSmall` notice in place of the plot. Under the cell, one line holds the coverage meter and,
 * when names or value labels are hidden, the note saying so; the line never changes the cell's
 * height. A resize that keeps the cap and the fit stage keeps the fit, so the frame gets the same
 * spec and data and does not redraw for it; a 0 × 0 size keeps the last fit.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { BarchartSpec, CategoryRow, PickEvent, TimeWindow } from '../engine/api';
import type { BarContext } from '../vis/barAction';
import { barLayout } from '../engine/canvas2d/barLayout';
import { AXIS_FONT } from '../engine/canvas2d/layout';
import type { Measure } from '../engine/canvas2d/text';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { font } from '../styles/tokens';
import { fitBarchart, type BarchartFit, type BarchartModel } from '../vis/barchart';
import styles from './CategoryChart.module.css';
import { ChartFrame, type FrameSize } from './ChartFrame';
import { CoverageMeter } from './CoverageMeter';

/** The offscreen context of `axisMeasure`; null without 2D canvas support. */
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Text widths in `AXIS_FONT`; without a 2D context, the monospace advance of the token font. */
function axisMeasure(): Measure {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (ctx === null) return (s) => Array.from(s).length * font.size.xs * font.advance.mono;
  return (s) => {
    ctx.font = AXIS_FONT;
    return ctx.measureText(s).width;
  };
}

const stageOf = (f: BarchartFit): string => (f.notice === null ? f.hidden : f.notice);

interface Fitted {
  readonly model: BarchartModel;
  readonly size: FrameSize | null;
  readonly fit: BarchartFit | null;
}

/** The fit of `model` at `size`; `prev` itself when the cap and the stage are unchanged. */
function refit(model: BarchartModel, size: FrameSize | null, prev: Fitted | null): Fitted {
  if (size === null) return { model, size, fit: prev?.model === model ? prev.fit : null };
  const fit = fitBarchart(model, size, axisMeasure());
  const old = prev?.model === model ? prev.fit : null;
  const same = old !== null && old.cap === fit.cap && stageOf(old) === stageOf(fit);
  return { model, size, fit: same ? old : fit };
}

/** The note line for the labels the fit or the layout hid; null when every label shows. */
function noteText(names: boolean, values: boolean): string | null {
  if (names && values) return t('chart.bar.bothHidden');
  if (names) return t('chart.bar.namesHidden');
  return values ? t('chart.bar.valuesHidden') : null;
}

/** The bar tooltip's lines (plan #173 Part 3a §3.5). Stub (tests first). */
export function markLines(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  row: CategoryRow,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  o: {
    readonly model: BarchartModel;
    readonly ghost: boolean;
    readonly anomaly: boolean;
    readonly context?: Omit<BarContext, 'model'>;
    readonly window: TimeWindow;
    readonly timeZone: string;
  },
): string[] {
  return [];
}

export function CategoryChart({
  model,
  title,
  onNarrow,
  sizeMemo,
  onPick,
}: {
  model: BarchartModel;
  title: string;
  onNarrow: () => void;
  sizeMemo?: { current: FrameSize | null };
  onPick?: (e: PickEvent, returnFocus: HTMLElement | null) => void;
  context?: Omit<BarContext, 'model'>;
  ghost?: boolean;
  anomaly?: boolean;
  table?: boolean;
  onTable?: (on: boolean) => void;
  baselineFailed?: boolean;
}): JSX.Element {
  const cellRef = useRef<HTMLDivElement>(null);
  const own = useRef<FrameSize | null>(null);
  const memo = sizeMemo ?? own;
  const [state, setState] = useState<Fitted>(() => refit(model, null, null));
  // A new model refits at the current size before any paint (React's "adjust state during render").
  let current = state;
  if (state.model !== model) {
    current = refit(model, state.size, state);
    setState(current);
  }
  // eslint-disable-next-line react-hooks/immutability -- the memo is the caller's ref, kept for the pre-size (#90)
  useEffect(() => {
    const el = cellRef.current;
    if (el === null) return;
    const apply = (w: number, h: number): void => {
      const width = Math.floor(w);
      const height = Math.floor(h);
      // A hidden cell (0 × 0) keeps the last fit.
      if (!(width > 0) || !(height > 0)) return;
      memo.current = { width, height };
      setState((s) =>
        s.size?.width === width && s.size.height === height
          ? s
          : refit(s.model, { width, height }, s),
      );
    };
    // The caller's last size first, so a re-mounted chart fits before the observer reports.
    const last = memo.current;
    if (last !== null) apply(last.width, last.height);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r !== undefined) apply(r.width, r.height);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [memo]);
  const { fit, size } = current;
  const spec = useMemo<BarchartSpec | null>(
    () => (fit?.notice === null ? { ...fit.spec, title } : null),
    [fit, title],
  );
  const note = useMemo(() => {
    if (fit === null || fit.notice !== null || size === null) return null;
    // Names the layout itself hides (no distinct fit) count as hidden too (T22-004).
    const laid = barLayout(fit.spec, fit.data.categories, size.width, size.height, axisMeasure());
    const names = fit.hidden === 'names' || fit.hidden === 'namesValues' || laid.names === null;
    return noteText(names, fit.hidden === 'namesValues' || fit.hidden === 'values');
  }, [fit, size]);
  return (
    <div className={cx(styles['root'])} data-category-chart="">
      <div ref={cellRef} className={cx(styles['cell'])} data-category-cell="">
        {fit?.notice === null && spec !== null && (
          <ChartFrame
            spec={spec}
            data={fit.data}
            fill
            sizeMemo={memo}
            {...(onPick === undefined ? {} : { onPick })}
          />
        )}
        {fit?.notice === 'tooSmall' && (
          <p className={cx(styles['tooSmall'])} data-too-small="">
            {fit.text}
          </p>
        )}
      </div>
      <div className={cx(styles['under'])}>
        {fit !== null && <CoverageMeter coverage={fit.coverage} onNarrow={onNarrow} />}
        {note !== null && (
          <p className={cx(styles['note'])} data-hidden-note="">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
