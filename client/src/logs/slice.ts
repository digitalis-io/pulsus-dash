/**
 * The stream's slice of the buffer (plan #66 Part B §3.5, §4.5): the ordinals given to the
 * virtualiser, bounded by rows (`cap`, plus `margin` while scrolling) and by pixels (`maxPx` at
 * rest, `hardPx` always), so the virtualiser never holds more than ~220 000 offsets and the list
 * stays below every browser's element height limit. The slice moves only at rest, by an explicit
 * anchor (the ordinal at the top and its pixel offset), so what the reader sees does not move.
 */

/** Ordinals [start, end) given to the virtualiser. Ordinals no longer held (evicted while the
 *  list scrolled) render as placeholder rows of their last known height until the next re-slice. */
export interface Slice {
  readonly start: number;
  readonly end: number;
}

/** cap rows (soft: + margin while scrolling); margin rows (upper bound, see marginOf); maxPx: the
 *  extent bound at rest; hardPx: the bound that forces a re-slice even while scrolling. */
export interface ViewLimits {
  readonly cap: number;
  readonly margin: number;
  readonly maxPx: number;
  readonly hardPx: number;
}

export const DEFAULT_VIEW: ViewLimits = {
  cap: 200_000,
  margin: 20_000,
  maxPx: 8_000_000,
  hardPx: 12_000_000,
};

/** Pixel height of a row: its measured size inside the slice, else the estimate (§3.7). */
export type HeightOf = (ord: number) => number;

/** min(v.margin, floor((s.end − s.start) / 4)): a slice the pixel bound made short gets a short margin. */
export function marginOf(s: Slice, v: ViewLimits): number {
  return Math.min(v.margin, Math.floor((s.end - s.start) / 4));
}

/** While scrolling: start never moves; end grows towards min(endOrd, start + cap + margin), one row
 *  at a time from s.end, stopping before extentPx + the added heights would exceed maxPx. */
export function growSlice(
  s: Slice,
  endOrd: number,
  v: ViewLimits,
  extentPx: number,
  h: HeightOf,
): Slice {
  const target = Math.min(endOrd, s.start + v.cap + v.margin);
  let end = s.end;
  let px = extentPx;
  while (end < target) {
    const hp = h(end);
    if (px + hp > v.maxPx) break;
    px += hp;
    end += 1;
  }
  return end === s.end ? s : { start: s.start, end };
}

/** The slice around `ord`: rows added alternately below and above (below first), a side at the
 *  buffer's edge giving its share to the other, until cap rows or until the next row would take
 *  the extent over maxPx; always holds `ord`. O(cap). */
export function sliceAround(
  ord: number,
  firstOrd: number,
  endOrd: number,
  v: ViewLimits,
  h: HeightOf,
): Slice {
  if (endOrd <= firstOrd) return { start: firstOrd, end: firstOrd };
  const at = Math.min(Math.max(ord, firstOrd), endOrd - 1);
  let start = at;
  let end = at + 1;
  let px = h(at);
  let below = true;
  while (end - start < v.cap) {
    const canBelow = end < endOrd;
    const canAbove = start > firstOrd;
    if (!canBelow && !canAbove) break;
    const down: boolean = (below && canBelow) || !canAbove;
    const hp = h(down ? end : start - 1);
    if (px + hp > v.maxPx) break;
    px += hp;
    if (down) end += 1;
    else start -= 1;
    below = !down;
  }
  return { start, end };
}

/** At rest, with m = marginOf(s, v), re-slice when any holds: s.start < firstOrd or s.end > endOrd;
 *  b ≥ s.end − m and s.end < endOrd; a < s.start + m and s.start > firstOrd; s.end − s.start > cap;
 *  extentPx > maxPx. a, b: first and last visible ordinal. */
export function wantsRecentre(
  s: Slice,
  a: number,
  b: number,
  firstOrd: number,
  endOrd: number,
  extentPx: number,
  v: ViewLimits,
): boolean {
  const m = marginOf(s, v);
  return (
    s.start < firstOrd ||
    s.end > endOrd ||
    (b >= s.end - m && s.end < endOrd) ||
    (a < s.start + m && s.start > firstOrd) ||
    s.end - s.start > v.cap ||
    extentPx > v.maxPx
  );
}

export interface Layout {
  readonly head: boolean;
  readonly tail: boolean;
  readonly count: number;
}

/** head = s.start <= firstOrd && !atStart; tail = s.end >= endOrd; count = (s.end − s.start) + head + tail. */
export function layoutOf(s: Slice, firstOrd: number, endOrd: number, atStart: boolean): Layout {
  const head = s.start <= firstOrd && !atStart;
  const tail = s.end >= endOrd;
  return { head, tail, count: s.end - s.start + (head ? 1 : 0) + (tail ? 1 : 0) };
}

export function ordAt(index: number, s: Slice, l: Layout): number | 'head' | 'tail' {
  if (l.head && index === 0) return 'head';
  const i = index - (l.head ? 1 : 0);
  return i >= s.end - s.start ? 'tail' : s.start + i;
}

export function indexOf(ord: number, s: Slice, l: Layout): number | null {
  if (ord < s.start || ord >= s.end) return null;
  return ord - s.start + (l.head ? 1 : 0);
}

/** What the reader sees: an ordinal and scrollTop − that row's start (negative when a head
 *  sentinel is above it at the top). */
export interface Anchor {
  readonly ord: number;
  readonly offsetPx: number;
}

/** Never null. In order: (1) the first row item (not a sentinel) whose end > scrollTop, offset
 *  scrollTop − its start (negative when the head sentinel is at the top); (2) else (the tail
 *  sentinel is at the top) the last row item, offset scrollTop − its start; (3) else (no row
 *  item: an empty slice) {ord: s.start, offsetPx: 0}. When endOrd > firstOrd the ordinal is then
 *  clamped to [firstOrd, endOrd − 1] (offset 0 if it moved); an empty buffer gives
 *  {ord: firstOrd, offsetPx: 0}. */
export function anchorOf(
  items: readonly { index: number; start: number; end: number }[],
  scrollTop: number,
  s: Slice,
  l: Layout,
  firstOrd: number,
  endOrd: number,
): Anchor {
  let found: Anchor | null = null;
  let last: Anchor | null = null;
  for (const it of items) {
    const ord = ordAt(it.index, s, l);
    if (typeof ord !== 'number') continue;
    last = { ord, offsetPx: scrollTop - it.start };
    if (it.end > scrollTop) {
      found = last;
      break;
    }
  }
  const a = found ?? last ?? { ord: s.start, offsetPx: 0 };
  if (endOrd <= firstOrd) return { ord: firstOrd, offsetPx: 0 };
  const ord = Math.min(Math.max(a.ord, firstOrd), endOrd - 1);
  return ord === a.ord ? a : { ord, offsetPx: 0 };
}

/** The start of an index: the virtualiser's measurement when it has one for that index, else
 *  (head sentinel size if l.head) + Σ h(ord) over the slice before it. */
export function startOf(
  index: number,
  measured: (i: number) => number | undefined,
  s: Slice,
  l: Layout,
  h: HeightOf,
  sentinelPx: number,
): number {
  const m = measured(index);
  if (m !== undefined) return m;
  const at = ordAt(index, s, l);
  if (at === 'head') return 0;
  const to = at === 'tail' ? s.end : at;
  let px = l.head ? sentinelPx : 0;
  for (let o = s.start; o < to; o += 1) px += h(o);
  return px;
}

/** Never null: start(indexOf(a.ord)) + a.offsetPx clamped to [0, maxScroll]; when a.ord is not in
 *  the slice (sliceAround always includes it, so only a defect), the start of the slice's first row. */
export function restoreOffset(
  a: Anchor,
  start: (index: number) => number,
  s: Slice,
  l: Layout,
  maxScroll: number,
): number {
  const clamp = (x: number) => Math.min(Math.max(x, 0), Math.max(0, maxScroll));
  const i = indexOf(a.ord, s, l);
  if (i === null) return clamp(start(l.head ? 1 : 0));
  return clamp(start(i) + a.offsetPx);
}
