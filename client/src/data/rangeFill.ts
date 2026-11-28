/**
 * The rank 0 fill (#304 Part B §4.2): a view's missing visible buckets drawn from the family's
 * other steps at their own sample times, never resampled (T04-005). For each maximal span of
 * missing buckets the source is, among the steps whose held buckets cover the span completely,
 * the one nearest the view's by ratio (`|log(step / viewStep)|` least; a tie goes to the finer);
 * with none the span is a gap (its view-step grid points, NaN). `ts` is the sorted union of the
 * held view-step buckets' grid points and each source's sample times inside its span.
 */
import { bucketLastMs, bucketOf, bucketStartMs } from './buckets';
import type { RangeResult } from './decode';
import type { SeriesFrame } from './frames';
import { keysOf, mergeCompleteness } from './rangeStitch';

/** One step's held buckets of a family. */
export interface StepSource {
  readonly stepMs: number;
  /** Held bucket k (at `stepMs`) → the segment result that holds it. */
  readonly buckets: ReadonlyMap<number, RangeResult>;
}

export interface FillInput {
  readonly stepMs: number;
  /** The visible buckets `k0 ≤ k < k1` at `stepMs`. */
  readonly k0: number;
  readonly k1: number;
  /** The view-step buckets held (k → the segment result). */
  readonly own: ReadonlyMap<number, RangeResult>;
  readonly others: readonly StepSource[];
}

export interface Filled {
  readonly result: RangeResult;
  readonly rank: 0 | 1;
  /** The step each missing span was filled from (null: a gap), in span order. */
  readonly sources: readonly (number | null)[];
}

/** A run of samples from one result: indices `i0 ≤ i < i1`, or a gap of `n` grid points. */
type Piece =
  | {
      readonly kind: 'samples';
      readonly result: RangeResult;
      readonly i0: number;
      readonly i1: number;
    }
  | { readonly kind: 'gap'; readonly fromMs: number; readonly stepMs: number; readonly n: number };

/** Indices of `r`'s samples with fromMs ≤ t ≤ toMs (its grid is regular). */
function window(r: RangeResult, fromMs: number, toMs: number): [number, number] {
  const n = Math.round((r.endMs - r.startMs) / r.stepMs) + 1;
  const i0 = Math.max(0, Math.ceil((fromMs - r.startMs) / r.stepMs));
  const i1 = Math.min(n, Math.floor((toMs - r.startMs) / r.stepMs) + 1);
  return [i0, Math.max(i0, i1)];
}

/** The source covering [fromMs, toMs] completely, nearest by ratio; null for none. */
function pick(others: readonly StepSource[], viewStep: number, fromMs: number, toMs: number) {
  let best: StepSource | null = null;
  let bestD = Infinity;
  for (const o of others) {
    if (o.stepMs === viewStep) continue;
    let covers = true;
    for (let k = bucketOf(fromMs, o.stepMs); k <= bucketOf(toMs, o.stepMs); k++) {
      if (!o.buckets.has(k)) {
        covers = false;
        break;
      }
    }
    if (!covers) continue;
    const d = Math.abs(Math.log(o.stepMs / viewStep));
    if (
      d < bestD - 1e-12 ||
      (Math.abs(d - bestD) <= 1e-12 && best !== null && o.stepMs < best.stepMs)
    ) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

export function fillRange(i: FillInput): Filled {
  const pieces: Piece[] = [];
  const sources: (number | null)[] = [];
  const vs = i.stepMs;
  let k = i.k0;
  while (k < i.k1) {
    const own = i.own.get(k);
    if (own !== undefined) {
      const [a, b] = window(own, bucketStartMs(k, vs), bucketLastMs(k, vs));
      pieces.push({ kind: 'samples', result: own, i0: a, i1: b });
      k++;
      continue;
    }
    let e = k;
    while (e < i.k1 && !i.own.has(e)) e++;
    const fromMs = bucketStartMs(k, vs);
    const toMs = bucketLastMs(e - 1, vs);
    const src = pick(i.others, vs, fromMs, toMs);
    sources.push(src?.stepMs ?? null);
    if (src === null) {
      pieces.push({ kind: 'gap', fromMs, stepMs: vs, n: (e - k) * 256 });
    } else {
      for (let kk = bucketOf(fromMs, src.stepMs); kk <= bucketOf(toMs, src.stepMs); kk++) {
        const r = src.buckets.get(kk);
        if (r === undefined) continue;
        const lo = Math.max(fromMs, bucketStartMs(kk, src.stepMs));
        const hi = Math.min(toMs, bucketLastMs(kk, src.stepMs));
        const [a, b] = window(r, lo, hi);
        if (b > a) pieces.push({ kind: 'samples', result: r, i0: a, i1: b });
      }
    }
    k = e;
  }
  const results = pieces.flatMap((p) => (p.kind === 'samples' ? [p.result] : []));
  const order = keysOf(results);
  let n = 0;
  for (const p of pieces) n += p.kind === 'samples' ? p.i1 - p.i0 : p.n;
  const ts = new Float64Array(n);
  const values = new Map<string, Float64Array>(
    order.map((key) => [key, new Float64Array(n).fill(NaN)]),
  );
  const absent = new Map<string, Uint8Array>(order.map((key) => [key, new Uint8Array(n).fill(1)]));
  const labels = new Map<string, SeriesFrame['labels']>();
  let at = 0;
  for (const p of pieces) {
    if (p.kind === 'gap') {
      for (let j = 0; j < p.n; j++) ts[at + j] = p.fromMs + j * p.stepMs;
      at += p.n;
      continue;
    }
    const len = p.i1 - p.i0;
    for (let j = 0; j < len; j++) ts[at + j] = p.result.startMs + (p.i0 + j) * p.result.stepMs;
    p.result.series.forEach((s, si) => {
      if (!labels.has(s.key)) labels.set(s.key, s.labels);
      values.get(s.key)?.set(s.values.subarray(p.i0, p.i1), at);
      const m = p.result.absent?.[si] ?? null;
      const a = absent.get(s.key);
      if (a === undefined) return;
      if (m === null) a.fill(0, at, at + len);
      else a.set(m.subarray(p.i0, p.i1), at);
    });
    at += len;
  }
  const series: SeriesFrame[] = order.map((key) => ({
    key,
    labels: labels.get(key) ?? {},
    timestamps: ts,
    values: values.get(key) ?? new Float64Array(n),
  }));
  const masks = order.map((key) => {
    const a = absent.get(key);
    return a === undefined || a.every((x) => x === 0) ? null : a;
  });
  const last = results.at(-1);
  const base = last ?? null;
  const result: RangeResult = {
    planned: base?.planned ?? {
      query: '',
      expanded: '',
      bytes: 0,
      valueType: 'unknown',
      rateCandidate: false,
      rateApplied: false,
      histogram: false,
    },
    startMs: ts[0] ?? bucketStartMs(i.k0, vs),
    endMs: ts[n - 1] ?? bucketLastMs(i.k1 - 1, vs),
    stepMs: vs,
    series,
    completeness:
      base === null
        ? {
            truncated: false,
            warnings: [],
            infos: [],
            queryId: null,
            dataAgeMs: null,
            readCache: null,
            readCacheThroughMs: null,
          }
        : mergeCompleteness(results, base),
    ...(masks.some((m) => m !== null) ? { absent: masks } : {}),
  };
  return { result, rank: sources.length === 0 ? 1 : 0, sources };
}
