/**
 * Label text that fits a width (plan #64 Part C §4.2): the threshold labels' `truncated` (ADR-0022,
 * moved here from `thresholdMark.ts`) and the event labels' `fitText` (ADR-0023). Widths are the
 * context's `measureText` in its current font; prefixes are whole code points.
 */
import type { Ctx2D } from './ctx';

/**
 * The longest prefix of `text`, at least 2 code points and shorter than the text, that fits `room`
 * with `…` appended; null when none does.
 */
export function fitText(ctx: Ctx2D, text: string, room: number): string | null {
  const cps = Array.from(text);
  // Widths grow with the prefix: binary search for the longest that fits.
  let lo = 2;
  let hi = cps.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const n = Math.floor((lo + hi) / 2);
    const candidate = `${cps.slice(0, n).join('')}…`;
    if (ctx.measureText(candidate).width <= room) {
      best = candidate;
      lo = n + 1;
    } else {
      hi = n - 1;
    }
  }
  return best;
}

/** `fitText`, or the first code point (a threshold label's glyph) when no prefix fits. */
export function truncated(ctx: Ctx2D, text: string, room: number): string {
  return fitText(ctx, text, room) ?? Array.from(text)[0] ?? '';
}

/** A text width in CSS px (`measureText(t).width` in the axis font). */
export type Measure = (text: string) => number;

const ELLIPSIS = '…';

/** `head…tail` keeping n code points of `cps`: the tail takes ⌈n/2⌉ of them once n ≥ 2. */
function middle(cps: readonly string[], n: number): string {
  const tail = n >= 2 ? Math.ceil(n / 2) : 0;
  const head = n - tail;
  return `${cps.slice(0, head).join('')}${ELLIPSIS}${cps.slice(cps.length - tail).join('')}`;
}

/**
 * `text` when it fits `room`; else the longest `head…tail` that does, the tail at least half of
 * the kept code points (a single kept code point is the head); '' when not even `…` fits.
 */
export function fitMiddle(m: Measure, text: string, room: number): string {
  if (m(text) <= room) return text;
  const cps = Array.from(text);
  // Widths grow with the kept count: binary search for the most that fits.
  let lo = 0;
  let hi = cps.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const n = Math.floor((lo + hi) / 2);
    const candidate = middle(cps, n);
    if (m(candidate) <= room) {
      best = candidate;
      lo = n + 1;
    } else {
      hi = n - 1;
    }
  }
  return best ?? '';
}

/** Whether a fitted name keeps at least one character of the name (not just `…`). */
const hasNameCharacter = (fitted: string): boolean => fitted.replaceAll(ELLIPSIS, '') !== '';

/**
 * The visible category names (T22-004; plan #173 Part 2 §4.2), never thinned: (1) each name fitted
 * to `room` with `fitMiddle`; (2) labels that are still equal get ` (k)`, k 1-based among them in
 * row order, the name fitted into the rest; (3) labels equal after that get ` (i)`, i the draw index,
 * until all differ. Null (hide every name) when a name must be shortened in a room under
 * `measure('MMMM')`, or a label is wider than the room or keeps no name character.
 */
export function distinctLabels(
  m: Measure,
  names: readonly string[],
  room: number,
): string[] | null {
  const unique = (ls: readonly string[]): boolean => new Set(ls).size === ls.length;
  if (names.every((n) => m(n) <= room) && unique(names)) return [...names];
  if (room < m('MMMM')) return null;
  const fitted = names.map((n) => fitMiddle(m, n, room));
  const labels = [...fitted];
  const suffixed = (i: number, suffix: string): boolean => {
    const part = fitMiddle(m, names[i] ?? '', room - m(suffix));
    fitted[i] = part;
    labels[i] = `${part}${suffix}`;
    return hasNameCharacter(part);
  };
  const colliders = (): Map<string, number[]> => {
    const at = new Map<string, number[]>();
    labels.forEach((l, i) => {
      at.set(l, [...(at.get(l) ?? []), i]);
    });
    return new Map([...at].filter(([, is]) => is.length > 1));
  };
  for (const is of colliders().values()) {
    for (const [k, i] of is.entries()) if (!suffixed(i, ` (${String(k + 1)})`)) return null;
  }
  // Draw-index suffixes differ, so this ends; the bound only guards pathological names.
  for (let round = 0; round <= names.length; round++) {
    const left = colliders();
    if (left.size === 0) break;
    for (const is of left.values()) {
      for (const i of is) if (!suffixed(i, ` (${String(i)})`)) return null;
    }
  }
  if (!unique(labels)) return null;
  if (labels.some((l, i) => m(l) > room || !hasNameCharacter(fitted[i] ?? ''))) return null;
  return labels;
}
