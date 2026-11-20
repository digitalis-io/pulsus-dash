export interface ValueTicks {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

export function valueTicks(
  _dataMin: number,
  _dataMax: number,
  _heightPx: number,
  _labelHeightPx: number,
  _base: 1000 | 1024,
): ValueTicks {
  throw new Error('not implemented');
}
