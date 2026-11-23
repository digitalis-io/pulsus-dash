/**
 * Wrapped-row height estimates by ordinal (plan #66 Part B §3.5, §3.7). An estimate is kept once
 * made, so a row evicted while the list scrolls keeps its last known height as a placeholder; the
 * cache is pruned to the ordinals still held or still in the slice, so it stays bounded while the
 * pager pages without bound.
 */
export class RowEstimates {
  private readonly px = new Map<number, number>();

  get size(): number {
    return this.px.size;
  }

  get(ord: number): number | undefined {
    return this.px.get(ord);
  }

  set(ord: number, px: number): void {
    this.px.set(ord, px);
  }

  /** Drops every estimate outside `[from, to)`. */
  retain(from: number, to: number): void {
    // Stub: nothing is dropped yet.
    if (from > to) return;
  }
}
