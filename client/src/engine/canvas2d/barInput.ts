/**
 * The bar chart's input (ADR-0028, ADR-0029; plan #173 Part 2 §4.3, Part 3a §3.1), split from
 * `Canvas2DEngine.ts`. Pointer: `mark` when the band under the pointer changes (null once on
 * leaving every band); a left press without a modifier released within `DRAG_MIN_PX` of where it
 * started picks the band under it (`click`), and one that travelled further brushes the bands from
 * the press to the pointer, clamped to the drawn rows (`brush`). Keys on the frame's `keyTarget`
 * (the mirror listbox): a focus index f moved by the arrows, Home and End, a Shift move that
 * anchors at f and brushes the rows between, Enter or Space to pick f, Escape to drop the anchor.
 * The frame routes the bar chart's pointer and key events here, draws the focus mark and the brush
 * band from `overlay()` in its overlay pass, and ignores the bar chart's wheel, gestures, double
 * click and context menu.
 */
import type { FrameEvents } from '../api';
import { barAt, barByIndex, bandIndexAt, type BarPick } from './barchart';
import { DRAG_MIN_PX } from './input';

interface Press {
  readonly pointerId: number;
  readonly x0: number;
  readonly y0: number;
  travel: number;
  /** The band of the press, clamped; null when no band was drawn. */
  readonly band: number | null;
  /** The brushed bands, press first, while the travel reaches `DRAG_MIN_PX`. */
  brush: { readonly from: number; readonly to: number } | null;
}

/** The frame's emitter of `mark` and `pick`. */
export type BarEmit = <E extends 'mark' | 'pick'>(e: E, ev: FrameEvents[E]) => void;

type Point = { readonly x: number; readonly y: number };

/** What the overlay pass draws: the focus band and the brushed bands (draw indices). */
export interface BarOverlay {
  readonly focus: number | null;
  readonly brush: { readonly lo: number; readonly hi: number } | null;
}

const NEXT_KEYS: ReadonlySet<string> = new Set(['ArrowRight', 'ArrowDown']);
const PREV_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowUp']);

/** The keys of the bands between `a` and `b` (either order), in draw order. */
function keysBetween(pick: BarPick, a: number, b: number): string[] {
  return pick.bands.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.key);
}

export class BarInput {
  /** The key of the last `mark`; null after a null `mark` or none yet. */
  private markKey: string | null = null;
  private markSource: 'pointer' | 'keyboard' | null = null;
  private press: Press | null = null;
  /** The keyboard focus index f; null while the key target is not focused. */
  private focus: number | null = null;
  /** The Shift brush anchor a. */
  private anchor: number | null = null;
  /** The key target has focus (review r1): f follows the drawn rows while it lasts. */
  private focused = false;

  /** `redraw` schedules an overlay-only frame: the focus mark or the brush band moved. */
  constructor(
    private readonly emit: BarEmit,
    private readonly redraw: () => void,
  ) {}

  /** The marked bar's key (pointer hover or keyboard focus); null when none is marked. */
  markedKey(): string | null {
    return this.markKey;
  }

  overlay(): BarOverlay {
    const b = this.press?.brush ?? null;
    return {
      focus: this.focus,
      brush: b === null ? null : { lo: Math.min(b.from, b.to), hi: Math.max(b.from, b.to) },
    };
  }

  /** A pointer move: the press travel and brush, then `mark` when the band under `p` changed. */
  move(pick: BarPick | null, pointerId: number, p: Point): void {
    const pr = this.press;
    if (pr !== null && pointerId === pr.pointerId) {
      pr.travel = Math.max(pr.travel, Math.hypot(p.x - pr.x0, p.y - pr.y0));
      const to = pick === null ? null : bandIndexAt(pick, p);
      if (pr.travel >= DRAG_MIN_PX && pr.band !== null && to !== null && pr.brush?.to !== to) {
        pr.brush = { from: pr.band, to };
        this.redraw();
      }
    }
    const hit = pick === null ? null : barAt(pick, p);
    if (hit === null) {
      this.hoverEnd(pick);
      return;
    }
    if (hit.key === this.markKey && this.markSource === 'pointer') return;
    this.markKey = hit.key;
    this.markSource = 'pointer';
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
    this.markSource = null;
    this.emit('mark', null);
  }

  /**
   * The pointer left every bar or the chart: with the key target focused, the keyboard mark of f
   * returns (its active option and tooltip); else one null `mark`.
   */
  hoverEnd(pick: BarPick | null): void {
    if (this.markSource !== 'pointer') return;
    if (this.focused && this.focus !== null && pick !== null) {
      this.markFocus(pick);
      return;
    }
    this.clearMark();
  }

  /** A press: only the left button without a modifier can pick or brush; true when it can. */
  down(e: PointerEvent, p: Point, pick: BarPick | null): boolean {
    this.press = null;
    if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    const band = pick === null ? null : bandIndexAt(pick, p);
    this.press = { pointerId: e.pointerId, x0: p.x, y0: p.y, travel: 0, band, brush: null };
    return true;
  }

  /**
   * A release: a press that travelled `DRAG_MIN_PX` brushes the bands from the press to `p`
   * (clamped); one that did not picks the band under `p` ([] for none).
   */
  up(pick: BarPick | null, pointerId: number, p: Point): void {
    const pr = this.press;
    if (pr === null || pointerId !== pr.pointerId) return;
    this.press = null;
    if (pr.brush !== null) this.redraw();
    if (pick === null) return;
    const travel = Math.max(pr.travel, Math.hypot(p.x - pr.x0, p.y - pr.y0));
    if (travel >= DRAG_MIN_PX) {
      const to = bandIndexAt(pick, p);
      if (pr.band === null || to === null) return;
      this.emit('pick', {
        keys: keysBetween(pick, pr.band, to),
        gesture: 'brush',
        source: 'pointer',
      });
      return;
    }
    const hit = barAt(pick, p);
    this.emit('pick', { keys: hit === null ? [] : [hit.key], gesture: 'click', source: 'pointer' });
  }

  /** `pointercancel`, `lostpointercapture`: the press ends without a pick. */
  cancel(): void {
    if (this.press?.brush != null) this.redraw();
    this.press = null;
  }

  /** The key target gained focus: f = min(f ?? 0, n − 1) and a keyboard `mark`. */
  focusIn(pick: BarPick | null): void {
    this.focused = true;
    const n = pick?.bands.length ?? 0;
    if (pick === null || n === 0) return;
    this.focus = Math.min(this.focus ?? 0, n - 1);
    this.markFocus(pick);
  }

  /** The key target lost focus: f and a are dropped and a keyboard `mark` is cleared. */
  blur(): void {
    this.focused = false;
    const had = this.focus !== null;
    this.focus = null;
    this.anchor = null;
    if (this.markSource === 'keyboard') this.clearMark();
    if (had) this.redraw();
  }

  /**
   * A keydown on the key target (§3.1): handled keys are prevented. Ctrl, Meta and Alt are left
   * alone, and so is Escape, which only drops the anchor so that the T25 ladder clears the
   * selection.
   */
  key(e: KeyboardEvent, pick: BarPick | null): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      this.anchor = null;
      return;
    }
    const n = pick?.bands.length ?? 0;
    const f = this.focus;
    if (pick === null || n === 0) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const band = f === null ? null : barByIndex(pick, f);
      if (band === null) return;
      e.preventDefault();
      this.emit('pick', { keys: [band.key], gesture: 'click', source: 'keyboard' });
      return;
    }
    let next: number;
    if (NEXT_KEYS.has(e.key)) next = f === null ? 0 : f + 1;
    else if (PREV_KEYS.has(e.key)) next = f === null ? 0 : f - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    next = Math.min(n - 1, Math.max(0, next));
    if (e.shiftKey) this.anchor ??= f ?? next;
    else this.anchor = null;
    this.focus = next;
    this.markFocus(pick);
    const a = this.anchor;
    if (e.shiftKey && a !== null) {
      this.emit('pick', { keys: keysBetween(pick, a, next), gesture: 'brush', source: 'keyboard' });
    }
  }

  /** New data: the anchor is dropped; f is clamped once the layer is laid out (`laidOut`). */
  newData(): void {
    this.anchor = null;
  }

  /**
   * The layer was drawn: while the key target is focused, f is clamped to the drawn rows (null
   * with none; the first bar when it was null), and a keyboard `mark` that the layout change
   * cleared is emitted again for the band at f.
   */
  laidOut(pick: BarPick | null): void {
    if (!this.focused) return;
    const n = pick?.bands.length ?? 0;
    if (pick === null || n === 0) {
      this.focus = null;
      this.anchor = null;
      return;
    }
    // Focus that came before the first layout, or rows that came back: the first bar.
    this.focus = Math.min(this.focus ?? 0, n - 1);
    if (this.markKey === null) this.markFocus(pick);
  }

  dispose(): void {
    this.markKey = null;
    this.markSource = null;
    this.press = null;
    this.focus = null;
    this.anchor = null;
    this.focused = false;
  }

  private markFocus(pick: BarPick): void {
    const band = this.focus === null ? null : barByIndex(pick, this.focus);
    if (band === null) return;
    this.markKey = band.key;
    this.markSource = 'keyboard';
    this.emit('mark', {
      source: 'keyboard',
      key: band.key,
      index: band.index,
      xCss: band.xCss,
      yCss: band.yCss,
      rows: [band.row],
    });
    this.redraw();
  }
}
