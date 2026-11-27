/**
 * The geomap's marks (T24-090, T24-091, T24 §4.11; plan #234 Part 2 §3.3, §4.6): the radii, the
 * clusters of a level, the draw and keyboard orders and the greedy labels. Strings compare by UTF-16
 * code units (JavaScript `<`). Pure and renderer-free: any engine that paints a geomap reuses it.
 */
import type { GeoMapSpec } from '../../api';
import type { State } from '../../../theme/stateEncoding';
import type { GeoFrame } from '../../../vis/geo/frame';
import { uOf, vOf, worldPx } from './project';

/** One mark of a level: a marker (one row) or a cluster (≥ 2 rows, `cluster:` + the seed key). */
export interface LaidMark {
  readonly id: string;
  readonly kind: 'marker' | 'cluster';
  /** Sorted (UTF-16 code units). */
  readonly keys: readonly string[];
  /** Row indices, in key order. */
  readonly rows: readonly number[];
  /** The seed's row index. */
  readonly seed: number;
  /** World units [0, 1]: the seed's position. */
  readonly u: number;
  readonly v: number;
  readonly r: number;
  /** A cluster takes its members' max rank and |v|. */
  readonly rank: number;
  readonly absV: number;
}

/** Marks with their centres, CSS px (parallel arrays). */
export interface Placed {
  readonly marks: readonly LaidMark[];
  readonly x: Float64Array;
  readonly y: Float64Array;
}

export interface LabelBox {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** With a pattern (≥ 2 groups) a marker is at least this large, so the pattern reads. */
const PATTERN_MIN_R = 8;
/** Seeds take the unassigned rows within this many world px at the level. */
export const CLUSTER_PX = 40;
/** Names are drawn when a level has at most this many marks. */
export const LABEL_MAX_MARKS = 50;
/** A label starts this far right of its marker's edge, CSS px. */
const LABEL_GAP = 4;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** rank: failing 4, degraded 3, watch 2, else 0. */
export function rankOf(s: State | null): number {
  switch (s) {
    case 'failing':
      return 4;
    case 'degraded':
      return 3;
    case 'watch':
      return 2;
    default:
      return 0;
  }
}

/** The cluster disc's radius: 14, 16, 18, 20 for n < 10, < 100, < 1 000, more. */
export function clusterRadius(n: number): number {
  return n < 10 ? 14 : n < 100 ? 16 : n < 1000 ? 18 : 20;
}

/**
 * The marker radius of each row (T24-090; 0 for a row not shown): patterned (≥ 2 groups) → min′ =
 * max(min, 8), max′ = max(max, min′); one group → min′ = min, max′ = max. M = the max |v| over the
 * shown rows; `value` → max(min′, max′·√(|v|/M)) (M = 0 → min′); `fixed` → max′.
 */
export function radiiOf(f: GeoFrame, size: GeoMapSpec['size']): Float64Array {
  const patterned = f.groups.length >= 2;
  const lo = patterned ? Math.max(size.min, PATTERN_MIN_R) : size.min;
  const hi = patterned ? Math.max(size.max, lo) : size.max;
  let M = 0;
  for (const i of f.shown) M = Math.max(M, Math.abs(f.rows[i]?.value ?? 0));
  const out = new Float64Array(f.rows.length);
  for (const i of f.shown) {
    const a = Math.abs(f.rows[i]?.value ?? 0);
    out[i] = size.by === 'fixed' ? hi : M > 0 ? Math.max(lo, hi * Math.sqrt(a / M)) : lo;
  }
  return out;
}

/**
 * The marks of level `z` (an integer) in seed order (−rank, −|v|, key): each seed takes the
 * unassigned shown rows within 40 world px (found through a 40 px grid); `cluster: false` takes only
 * rows at its exact position. Two or more rows make a cluster at the seed.
 */
export function levelMarks(
  f: GeoFrame,
  radii: Float64Array,
  z: number,
  cluster: boolean,
): LaidMark[] {
  const S = worldPx(z);
  const n = f.rows.length;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  const rank = new Uint8Array(n);
  const order: number[] = [];
  const cells = new Map<number, number[]>();
  const cellKey = (cx: number, cy: number): number => cx * 1_048_576 + cy;
  for (const i of f.shown) {
    const r = f.rows[i];
    if (r?.location.status !== 'placed') continue;
    u[i] = uOf(r.location.place.lon);
    v[i] = vOf(r.location.place.lat);
    rank[i] = rankOf(r.state);
    order.push(i);
    const k = cellKey(Math.floor((u[i] * S) / CLUSTER_PX), Math.floor((v[i] * S) / CLUSTER_PX));
    const c = cells.get(k);
    if (c === undefined) cells.set(k, [i]);
    else c.push(i);
  }
  const absOf = (i: number): number => Math.abs(f.rows[i]?.value ?? 0);
  const keyOf = (i: number): string => f.rows[i]?.key ?? '';
  order.sort(
    (a, b) => (rank[b] ?? 0) - (rank[a] ?? 0) || absOf(b) - absOf(a) || cmp(keyOf(a), keyOf(b)),
  );
  const taken = new Uint8Array(n);
  const out: LaidMark[] = [];
  const d2 = CLUSTER_PX * CLUSTER_PX;
  for (const s of order) {
    if (taken[s] === 1) continue;
    taken[s] = 1;
    const su = u[s] ?? 0;
    const sv = v[s] ?? 0;
    const members = [s];
    const cx = Math.floor((su * S) / CLUSTER_PX);
    const cy = Math.floor((sv * S) / CLUSTER_PX);
    const span = cluster ? 1 : 0;
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        for (const j of cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (taken[j] === 1) continue;
          const ju = u[j] ?? 0;
          const jv = v[j] ?? 0;
          const near = cluster
            ? ((ju - su) * S) ** 2 + ((jv - sv) * S) ** 2 <= d2
            : ju === su && jv === sv;
          if (!near) continue;
          taken[j] = 1;
          members.push(j);
        }
      }
    }
    members.sort((a, b) => a - b);
    const seedKey = keyOf(s);
    if (members.length === 1) {
      out.push({
        id: seedKey,
        kind: 'marker',
        keys: [seedKey],
        rows: members,
        seed: s,
        u: su,
        v: sv,
        r: radii[s] ?? 0,
        rank: rank[s] ?? 0,
        absV: absOf(s),
      });
      continue;
    }
    let mr = 0;
    let ma = 0;
    for (const j of members) {
      mr = Math.max(mr, rank[j] ?? 0);
      ma = Math.max(ma, absOf(j));
    }
    out.push({
      id: `cluster:${seedKey}`,
      kind: 'cluster',
      keys: members.map(keyOf),
      rows: members,
      seed: s,
      u: su,
      v: sv,
      r: clusterRadius(members.length),
      rank: mr,
      absV: ma,
    });
  }
  return out;
}

/** Bottom to top: (−r, rank, |v|, id). */
export function drawOrder(marks: readonly LaidMark[]): LaidMark[] {
  return [...marks].sort(
    (a, b) => b.r - a.r || a.rank - b.rank || a.absV - b.absV || cmp(a.id, b.id),
  );
}

/** The mark list's order: (y, x, id) of the centres, CSS px, exact. */
export function keyboardOrder(p: Placed): LaidMark[] {
  const idx = p.marks.map((_, i) => i);
  idx.sort(
    (a, b) =>
      (p.y[a] ?? 0) - (p.y[b] ?? 0) ||
      (p.x[a] ?? 0) - (p.x[b] ?? 0) ||
      cmp(p.marks[a]?.id ?? '', p.marks[b]?.id ?? ''),
  );
  return idx.map((i) => p.marks[i] as LaidMark);
}

/**
 * The marker names right of their marks (`labels: 'auto'`, T24-091): only with ≤ 50 marks, greedy
 * in `marks`' order (seed order), skipping a label that overlaps one already placed or leaves the
 * plot.
 */
export function placeLabels(
  marks: readonly LaidMark[],
  name: (m: LaidMark) => string,
  at: (m: LaidMark) => { x: number; y: number },
  measure: (s: string) => number,
  w: number,
  h: number,
  lineHeight = 14,
): LabelBox[] {
  if (marks.length > LABEL_MAX_MARKS) return [];
  const out: LabelBox[] = [];
  for (const m of marks) {
    if (m.kind !== 'marker') continue;
    const text = name(m);
    if (text === '') continue;
    const c = at(m);
    const box = {
      id: m.id,
      text,
      x: c.x + m.r + LABEL_GAP,
      y: c.y - lineHeight / 2,
      width: measure(text),
      height: lineHeight,
    };
    if (box.x < 0 || box.y < 0 || box.x + box.width > w || box.y + box.height > h) continue;
    const hit = out.some(
      (o) =>
        box.x < o.x + o.width &&
        o.x < box.x + box.width &&
        box.y < o.y + o.height &&
        o.y < box.y + box.height,
    );
    if (!hit) out.push(box);
  }
  return out;
}
