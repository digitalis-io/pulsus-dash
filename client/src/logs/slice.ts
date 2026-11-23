/** The stream's slice of the buffer (plan #66 Part B §3.5). Stub: implemented in the next commit. */
export interface Slice {
  readonly start: number;
  readonly end: number;
}
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
export type HeightOf = (ord: number) => number;
export interface Layout {
  readonly head: boolean;
  readonly tail: boolean;
  readonly count: number;
}
export interface Anchor {
  readonly ord: number;
  readonly offsetPx: number;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export function marginOf(s: Slice, v: ViewLimits): number {
  void [s, v];
  return notImplemented();
}
export function growSlice(
  s: Slice,
  endOrd: number,
  v: ViewLimits,
  extentPx: number,
  h: HeightOf,
): Slice {
  void [s, endOrd, v, extentPx, h];
  return notImplemented();
}
export function sliceAround(
  ord: number,
  firstOrd: number,
  endOrd: number,
  v: ViewLimits,
  h: HeightOf,
): Slice {
  void [ord, firstOrd, endOrd, v, h];
  return notImplemented();
}
export function wantsRecentre(
  s: Slice,
  a: number,
  b: number,
  firstOrd: number,
  endOrd: number,
  extentPx: number,
  v: ViewLimits,
): boolean {
  void [s, a, b, firstOrd, endOrd, extentPx, v];
  return notImplemented();
}
export function layoutOf(s: Slice, firstOrd: number, endOrd: number, atStart: boolean): Layout {
  void [s, firstOrd, endOrd, atStart];
  return notImplemented();
}
export function ordAt(index: number, s: Slice, l: Layout): number | 'head' | 'tail' {
  void [index, s, l];
  return notImplemented();
}
export function indexOf(ord: number, s: Slice, l: Layout): number | null {
  void [ord, s, l];
  return notImplemented();
}
export function anchorOf(
  items: readonly { index: number; start: number; end: number }[],
  scrollTop: number,
  s: Slice,
  l: Layout,
  firstOrd: number,
  endOrd: number,
): Anchor {
  void [items, scrollTop, s, l, firstOrd, endOrd];
  return notImplemented();
}
export function startOf(
  index: number,
  measured: (i: number) => number | undefined,
  s: Slice,
  l: Layout,
  h: HeightOf,
  sentinelPx: number,
): number {
  void [index, measured, s, l, h, sentinelPx];
  return notImplemented();
}
export function restoreOffset(
  a: Anchor,
  start: (index: number) => number,
  s: Slice,
  l: Layout,
  maxScroll: number,
): number {
  void [a, start, s, l, maxScroll];
  return notImplemented();
}
