/**
 * The bar chart's pointer input (ADR-0028, plan #173 Part 2 §4.3), split from `Canvas2DEngine.ts`:
 * `mark` when the band under the pointer changes (null once on leaving every band), and `pick` for
 * a left press without a modifier released within `DRAG_MIN_PX` of where it started. The frame
 * routes the bar chart's pointer events here and ignores its wheel, gestures, double click,
 * context menu and keys; the brush is #173 Part 3.
 */
import type { FrameEvents } from '../api';
import { barAt, type BarPick } from './barchart';
import { DRAG_MIN_PX } from './input';

interface Press {
  readonly pointerId: number;
  readonly x0: number;
  readonly y0: number;
  travel: number;
}

/** The frame's emitter of `mark` and `pick`. */
export type BarEmit = <E extends 'mark' | 'pick'>(e: E, ev: FrameEvents[E]) => void;

type Point = { readonly x: number; readonly y: number };

export class BarInput {
  /** The key of the last `mark`; null after a null `mark` or none yet. */
  private markKey: string | null = null;
  private press: Press | null = null;

  constructor(private readonly emit: BarEmit) {}

  /** A pointer move: the press travel, then `mark` when the band under `p` changed. */
  move(pick: BarPick | null, pointerId: number, p: Point): void {
    const pr = this.press;
    if (pr !== null && pointerId === pr.pointerId) {
      pr.travel = Math.max(pr.travel, Math.hypot(p.x - pr.x0, p.y - pr.y0));
    }
    const hit = pick === null ? null : barAt(pick, p);
    if (hit === null) {
      this.clearMark();
      return;
    }
    if (hit.key === this.markKey) return;
    this.markKey = hit.key;
    this.emit('mark', {
      source: 'pointer',
      key: hit.key,
      index: hit.index,
      xCss: hit.xCss,
      yCss: hit.yCss,
      rows: [hit.row],
    });
  }

  /** The pointer left, or the layout changed under it: one null `mark` if a bar was marked. */
  clearMark(): void {
    if (this.markKey === null) return;
    this.markKey = null;
    this.emit('mark', null);
  }

  /** A press: only the left button without a modifier can pick. */
  down(e: PointerEvent, p: Point): void {
    this.press = null;
    if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    this.press = { pointerId: e.pointerId, x0: p.x, y0: p.y, travel: 0 };
  }

  /** A release: `pick` the band under `p` ([] for none) unless the press travelled. */
  up(pick: BarPick | null, pointerId: number, p: Point): void {
    const pr = this.press;
    if (pr === null || pointerId !== pr.pointerId) return;
    this.press = null;
    const travel = Math.max(pr.travel, Math.hypot(p.x - pr.x0, p.y - pr.y0));
    if (travel >= DRAG_MIN_PX || pick === null) return;
    const hit = barAt(pick, p);
    this.emit('pick', {
      keys: hit === null ? [] : [hit.key],
      gesture: 'click',
      source: 'pointer',
    });
  }

  /** `pointercancel`, `lostpointercapture`: the press ends without a pick. */
  cancel(): void {
    this.press = null;
  }

  dispose(): void {
    this.markKey = null;
    this.press = null;
  }
}
