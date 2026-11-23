/**
 * Units in the last place between two doubles (#97 plan §10 Q1): the distance between their
 * IEEE-754 bit patterns on the ordered integer line, so −0 and +0 are 0 apart and adjacent
 * doubles are 1 apart across zero too. NaN or an infinity on either side gives Infinity.
 * `e2e:ticks-parity` allows WebKit's short nice rows a `min` and `max` within 4 ulps.
 */
const view = new DataView(new ArrayBuffer(8));
const SIGN = 1n << 63n;

function ordered(x: number): bigint {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  return bits & SIGN ? -(bits & ~SIGN) : bits;
}

export function ulpDistance(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b ? 0 : Infinity;
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}
