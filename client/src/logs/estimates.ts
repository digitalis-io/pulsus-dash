/**
 * Wrapped-row height estimates by ordinal (plan #66 Part B §3.5, §3.7). An estimate is kept once
 * made, so a row evicted while the list scrolls keeps its last known height as a placeholder; the
 * cache is pruned to the ordinals still held or still in the slice, so it stays bounded while the
 * pager pages without bound.
 */
export class RowEstimates {
  private readonly px = new Map<number, number>();
  /** Every key is in `[lo, hi)`. */
  private lo = 0;
  private hi = 0;

  get size(): number {
    return this.px.size;
  }

  get(ord: number): number | undefined {
    return this.px.get(ord);
  }

  set(ord: number, px: number): void {
    if (this.px.size === 0) {
      this.lo = ord;
      this.hi = ord + 1;
    } else {
      this.lo = Math.min(this.lo, ord);
      this.hi = Math.max(this.hi, ord + 1);
    }
    this.px.set(ord, px);
  }

  /** Drops every estimate outside `[from, to)`, in O(min(ordinals dropped, size)). */
  retain(from: number, to: number): void {
    if (this.px.size === 0) return;
    if (to <= from || to <= this.lo || from >= this.hi) {
      this.px.clear();
      return;
    }
    const below = Math.max(0, from - this.lo);
    const above = Math.max(0, this.hi - to);
    if (below + above === 0) return;
    if (below + above > this.px.size) {
      for (const ord of this.px.keys()) if (ord < from || ord >= to) this.px.delete(ord);
    } else {
      for (let o = this.lo; o < from; o += 1) this.px.delete(o);
      for (let o = to; o < this.hi; o += 1) this.px.delete(o);
    }
    this.lo = Math.max(this.lo, from);
    this.hi = Math.min(this.hi, to);
  }
}
