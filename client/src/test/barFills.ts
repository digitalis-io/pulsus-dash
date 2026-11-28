/**
 * The bar fills a layer recorded (`barFill.ts`): each `fill` whose gradient (or, plain, whose
 * colour) is one of `colours`, and each flat `fillRect` in one of them (maybe with an alpha byte), as `{ fillStyle, args: [x, y, w, h], globalAlpha }` with the bar's
 * base colour and its path's bounds, so tests read bars as they read `fillRect` calls.
 */
import type { RecordedOp, RecordingContext } from './recordingContext';

export interface BarFill {
  readonly fillStyle: string;
  readonly args: readonly [number, number, number, number];
  readonly globalAlpha: number;
  /** Drawn with the gradient (false: one plain fill). */
  readonly gradient: boolean;
}

export function barFillOf(o: RecordedOp, colours: ReadonlySet<string>): BarFill | null {
  if (o.op === 'fillRect') {
    // A narrow, flat time bar: its colour, maybe with an alpha byte.
    const base = o.fillStyle.slice(0, 7);
    if (!colours.has(base)) return null;
    const [x, y, w, h] = o.args.map(Number);
    return {
      fillStyle: base,
      args: [x ?? 0, y ?? 0, w ?? 0, h ?? 0],
      globalAlpha: o.globalAlpha,
      gradient: false,
    };
  }
  if (o.op !== 'fill' || o.path === null) return null;
  const first = o.stops?.[0]?.[1];
  const base = first !== undefined ? first.slice(0, 7) : o.fillStyle;
  if (!colours.has(base)) return null;
  return {
    fillStyle: base,
    args: o.path,
    globalAlpha: o.globalAlpha,
    gradient: first !== undefined,
  };
}

export function barFills(ctx: RecordingContext, colours: ReadonlySet<string>): BarFill[] {
  const out: BarFill[] = [];
  for (const o of ctx.ops) {
    const b = barFillOf(o, colours);
    if (b !== null) out.push(b);
  }
  return out;
}
