/**
 * The hover readout's placement: the card never covers the plot. It floats just outside the panel,
 * to the right, else to the left, vertically on the cursor; with no room on either side it docks
 * above the plot (over the panel's header band), else below it. Every position is clamped to the
 * viewport. The card is a manual popover in the top layer, so no panel or grid clips it.
 */
import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';
import type { HoverEvent, PlotRect } from '../engine/api';
import { formatHourMinute } from '../i18n/format';
import { t } from '../i18n/t';
import { useTimeZone } from '../state/timeZone';
import { space } from '../styles/tokens';

/** A rectangle in viewport CSS px. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ReadoutSide = 'right' | 'left' | 'above' | 'below';

export interface ReadoutPlacement {
  readonly x: number;
  readonly y: number;
  readonly side: ReadoutSide;
}

export interface ReadoutInput {
  /** The panel the card sits beside (a board panel, or the chart frame itself). */
  readonly panel: Box;
  /** The plot rectangle, which the card must not cover. */
  readonly plot: Box;
  readonly card: { readonly width: number; readonly height: number };
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The space between the card and the panel, and the card and the viewport edge. */
  readonly gap: number;
}

/** `v` clamped to [lo, hi]; `lo` wins when the range is empty. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

export function placeReadout(p: ReadoutInput): ReadoutPlacement {
  const { panel, plot, card, viewport, gap } = p;
  const y = clamp(p.cursorY - card.height / 2, gap, viewport.height - gap - card.height);
  const right = panel.x + panel.width + gap;
  if (right + card.width <= viewport.width - gap) return { x: right, y, side: 'right' };
  const left = panel.x - gap - card.width;
  if (left >= gap) return { x: left, y, side: 'left' };
  const x = clamp(p.cursorX - card.width / 2, gap, viewport.width - gap - card.width);
  const above = plot.y - gap - card.height;
  if (above >= gap) return { x, y: above, side: 'above' };
  const below = plot.y + plot.height + gap;
  if (below + card.height <= viewport.height - gap) return { x, y: below, side: 'below' };
  return { x, y: Math.max(gap, above), side: 'above' };
}

/** The board panel around `host`, else `host`. */
function panelOf(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>('[data-panel]') ?? host;
}

function popoverSupported(el: HTMLElement): boolean {
  return typeof el.showPopover === 'function';
}

function setOpen(el: HTMLElement, open: boolean): void {
  if (!popoverSupported(el)) return;
  if (open && !el.matches(':popover-open')) el.showPopover();
  if (!open && el.matches(':popover-open')) el.hidePopover();
}

const px = (v: number): string => `${String(Math.round(v))}px`;

/**
 * Places the readout `tip` for an anchor (host CSS px) outside the panel of `host`, beside
 * `plot`. Null hides it. The first placement after showing skips the follow transition, so the
 * card fades in where it belongs rather than sliding from the corner.
 */
export function useReadout(
  tipRef: RefObject<HTMLElement | null>,
  hostRef: RefObject<HTMLElement | null>,
  anchor: { readonly xCss: number; readonly yCss: number } | null,
  plot: PlotRect | null,
  deps: readonly unknown[],
): void {
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const host = hostRef.current;
    if (tip === null || host === null) return;
    if (anchor === null) {
      setOpen(tip, false);
      delete tip.dataset['follow'];
      return;
    }
    const fresh = tip.dataset['follow'] === undefined;
    setOpen(tip, true);
    const h = host.getBoundingClientRect();
    const pr = plot ?? { x: 0, y: 0, width: h.width, height: h.height };
    const placed = placeReadout({
      panel: panelOf(host).getBoundingClientRect(),
      plot: { x: h.x + pr.x, y: h.y + pr.y, width: pr.width, height: pr.height },
      card: { width: tip.offsetWidth, height: tip.offsetHeight },
      cursorX: h.x + anchor.xCss,
      cursorY: h.y + anchor.yCss,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      gap: space['2'],
    });
    // Without the popover top layer the card stays absolute in the host.
    const [ox, oy] = popoverSupported(tip) ? [0, 0] : [h.x, h.y];
    tip.dataset['side'] = placed.side;
    tip.style.translate = `${px(placed.x - ox)} ${px(placed.y - oy)}`;
    if (fresh) {
      // Commit the start position before the follow transition is enabled.
      tip.getBoundingClientRect();
      tip.dataset['follow'] = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller lists what moves the card
  }, deps);
}

/** The crosshair's values for a legend: series key to value, and the column's label. */
export interface HoveredValues {
  readonly label: string;
  readonly values: ReadonlyMap<string, number>;
}

/** The legend's hovered values for a time hover; null for none (the legend shows Last). */
export function hoveredValues(h: HoverEvent | null, tz: string): HoveredValues | null {
  if (h === null || h.tMs === null) return null;
  return {
    label: t('chart.legend.valueAt', { time: formatHourMinute(h.tMs, tz) }),
    values: new Map(h.rows.map((r) => [r.key, r.value])),
  };
}

/** A chart's hovered values for its legend, and the `onHover` that feeds them. */
export function useHoveredValues(): [HoveredValues | null, (h: HoverEvent | null) => void] {
  const tz = useTimeZone();
  const [hovered, setHovered] = useState<HoveredValues | null>(null);
  const onHover = useCallback(
    (h: HoverEvent | null) => {
      setHovered(hoveredValues(h, tz));
    },
    [tz],
  );
  return [hovered, onHover];
}

/**
 * Holds `ref`'s element at its current height while `active` (a legend beside a hovered chart):
 * the hovered values may rewrap it, and the chart it shares a stack with would resize and so end
 * its own hover.
 */
export function useHeightLock(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !active) return;
    el.style.height = px(el.offsetHeight);
    el.style.overflow = 'hidden';
    return () => {
      el.style.height = '';
      el.style.overflow = '';
    };
  }, [ref, active]);
}
