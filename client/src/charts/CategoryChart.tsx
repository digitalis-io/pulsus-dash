/**
 * A bar chart in a measured cell (plan #173 Part 2 §4.1, §4.4, Part 3a §3.5, §3.6; ADR-0028,
 * ADR-0029). The cell's size (whole CSS px; the caller's `sizeMemo` first, so a re-mounted chart
 * fits at once) goes through `fitBarchart` with an offscreen measure in the axis font. The fit
 * mounts a `ChartFrame`, or shows the focusable `tooSmall` notice in place of the plot. Under the
 * cell, one line holds the coverage meter and, when names or value labels are hidden or the baseline
 * run failed, the note saying so; the line never changes the cell's height. A resize that keeps the
 * cap and the fit stage keeps the fit, so the frame gets the same spec and data and does not redraw
 * for it; a 0 × 0 size keeps the last fit. The ghost and anomaly flags are set on the spec, with no
 * refit.
 *
 * The table view (T22-013): Shift+T anywhere in the chart (not in a text field) asks the caller to
 * flip `table`; with it on, the cell keeps its size and holds a `PanelTable` over `fit.rows`.
 * Opening focuses the grid; closing focuses the listbox when a frame is mounted, else the notice.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { BarchartSpec, CategoryRow, PickEvent, TimeWindow } from '../engine/api';
import type { BarContext } from '../vis/barAction';
import { barLayout } from '../engine/canvas2d/barLayout';
import { AXIS_FONT } from '../engine/canvas2d/layout';
import type { Measure } from '../engine/canvas2d/text';
import { formatHourMinute, formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import { useSelection } from '../inspector/host';
import { cx } from '../kit/cx';
import { inTextField } from '../kit/inTextField';
import { useTimeZone } from '../state/timeZone';
import { useTimeContext } from '../state/useTimeContext';
import { font } from '../styles/tokens';
import { barHint } from '../vis/barAction';
import { fitBarchart, type BarchartFit, type BarchartModel } from '../vis/barchart';
import styles from './CategoryChart.module.css';
import { ChartFrame, type FrameSize } from './ChartFrame';
import { CoverageMeter } from './CoverageMeter';
import { PanelTable } from './PanelTable';

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

/** The baseline run's incompleteness as a tooltip line (T22-006); null for a complete run. */
function baselineGap(m: BarchartModel): string | null {
  const b = m.baseline;
  if (b === null) return null;
  if (b.truncated) return t('coverage.baselineTruncated');
  const n = b.warnings.length;
  if (n === 0) return null;
  return n === 1 ? t('coverage.baselineLimitedOne', { n }) : t('coverage.baselineLimited', { n });
}

/**
 * The bar tooltip's lines after the name, value and state (plan #173 Part 3a §3.5), in order: with
 * the ghost on, `baseline <v>`, or what the baseline run lacks in its place (truncated, limited);
 * `barHint` (with a `context` only); the window the values are reduced over (T22-011: there is no
 * crosshair); and, with anomaly on, the note that this query has no scores.
 */
export function markLines(
  row: CategoryRow,
  o: {
    readonly model: BarchartModel;
    readonly ghost: boolean;
    readonly anomaly: boolean;
    readonly context?: Omit<BarContext, 'model'>;
    /** Used without a `context`. */
    readonly window: TimeWindow;
    readonly timeZone: string;
  },
): string[] {
  const out: string[] = [];
  if (o.ghost) {
    const gap = baselineGap(o.model);
    if (gap !== null) out.push(gap);
    else if (row.baseline !== null && Number.isFinite(row.baseline)) {
      out.push(t('chart.bar.baseline', { value: formatValue(row.baseline, o.model.spec.unit) }));
    }
  }
  if (o.context !== undefined) {
    const hint = barHint(row, { model: o.model, surface: o.context.surface });
    if (hint !== null) out.push(hint);
  }
  const w = o.context?.window ?? o.window;
  out.push(
    t('bar.reducedOver', {
      range: `${formatHourMinute(w.fromMs, o.timeZone)} – ${formatHourMinute(w.toMs, o.timeZone)}`,
    }),
  );
  if (o.anomaly && row.anomaly === null) out.push(t('bar.noAnomaly'));
  return out;
}

export function CategoryChart({
  model,
  title,
  onNarrow,
  sizeMemo,
  onPick,
  context,
  ghost = false,
  anomaly = false,
  table = false,
  onTable,
  baselineFailed = false,
}: {
  model: BarchartModel;
  title: string;
  onNarrow: () => void;
  sizeMemo?: { current: FrameSize | null };
  onPick?: (e: PickEvent, returnFocus: HTMLElement | null) => void;
  /** For `markLines` and the pick decision; absent: no filter hint. */
  context?: Omit<BarContext, 'model'>;
  ghost?: boolean;
  anomaly?: boolean;
  table?: boolean;
  onTable?: (on: boolean) => void;
  /** The shifted query failed: the under-line note `panel.baselineFailed`. */
  baselineFailed?: boolean;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const { window: ctxWindow } = useTimeContext();
  const timeZone = useTimeZone();
  const selection = useSelection();
  const selected = useMemo(() => new Set(selection?.keys ?? []), [selection]);
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
    () => (fit?.notice === null ? { ...fit.spec, title, ghost, anomaly } : null),
    [fit, title, ghost, anomaly],
  );
  const lines = useMemo(
    () =>
      (row: CategoryRow): readonly string[] =>
        markLines(row, {
          model,
          ghost,
          anomaly,
          ...(context === undefined ? {} : { context }),
          window: ctxWindow,
          timeZone,
        }),
    [model, ghost, anomaly, context, ctxWindow, timeZone],
  );

  // Shift+T flips the table (native listener: the root is no control of its own).
  const tableRef = useRef({ table, onTable });
  useLayoutEffect(() => {
    tableRef.current = { table, onTable };
  });
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onKey = (e: KeyboardEvent): void => {
      const cur = tableRef.current;
      if (cur.onTable === undefined || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'T' && e.key !== 't') return;
      if (inTextField(e.target)) return;
      e.preventDefault();
      cur.onTable(!cur.table);
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
    };
  }, []);
  // Focus follows the swap: the grid when it opens, the listbox (else the notice) when it closes.
  const shown = useRef(table);
  useEffect(() => {
    if (shown.current === table) return;
    shown.current = table;
    const root = rootRef.current;
    const to = table
      ? root?.querySelector<HTMLElement>('[role=grid]')
      : (root?.querySelector<HTMLElement>('[data-bar-list]') ??
        root?.querySelector<HTMLElement>('[data-too-small]'));
    to?.focus();
  }, [table]);
  const onRow =
    onPick === undefined
      ? undefined
      : (key: string, source: 'pointer' | 'keyboard', el: HTMLElement): void => {
          onPick({ keys: [key], gesture: 'click', source }, el);
        };
  const note = useMemo(() => {
    if (fit === null || fit.notice !== null || size === null) return null;
    // Names the layout itself hides (no distinct fit) count as hidden too (T22-004).
    const laid = barLayout(fit.spec, fit.data.categories, size.width, size.height, axisMeasure());
    const names = fit.hidden === 'names' || fit.hidden === 'namesValues' || laid.names === null;
    return noteText(names, fit.hidden === 'namesValues' || fit.hidden === 'values');
  }, [fit, size]);
  return (
    <div ref={rootRef} className={cx(styles['root'])} data-category-chart="">
      <div ref={cellRef} className={cx(styles['cell'])} data-category-cell="">
        {table && fit !== null && (
          <PanelTable
            rows={fit.rows}
            title={title}
            selected={selected}
            {...(onRow === undefined ? {} : { onRow })}
            onClose={() => onTable?.(false)}
          />
        )}
        {!table && fit?.notice === null && spec !== null && (
          <ChartFrame
            spec={spec}
            data={fit.data}
            fill
            sizeMemo={memo}
            markLines={lines}
            {...(onPick === undefined ? {} : { onPick })}
          />
        )}
        {!table && fit?.notice === 'tooSmall' && (
          <p
            className={cx(styles['tooSmall'])}
            role="group"
            // The table is one Shift+T away (T22-013): the notice is the chart's focus target.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label={t('chart.bar.tooSmallLabel', { title })}
            data-too-small=""
          >
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
        {baselineFailed && (
          <p className={cx(styles['note'])} data-baseline-failed="">
            {t('panel.baselineFailed')}
          </p>
        )}
      </div>
    </div>
  );
}
