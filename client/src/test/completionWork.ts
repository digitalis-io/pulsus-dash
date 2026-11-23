/**
 * The arithmetic of `bench:promql-completion-latency` (plan #107 §5.3; T09 §7, PRF-005): the work
 * per local key from the editor and completion probes, the percentiles, and the enforce gate. It is
 * pure, so `completionWork.test.ts` checks it with injected samples.
 *
 * A probe reports how long its work took when it ends; the page pushes `[performance.now(), ms,
 * kind]`, so an entry is the interval `[end − ms, end]`. The two completion slots of one request
 * share the memoised analysis and each times its entry to a point after awaiting it, so their
 * intervals overlap (slot 1's synchronous entry and the analysis's microtasks lie in both). The
 * work of a key is therefore the length of the **union** of its intervals, not their sum. Inside
 * one such interval nothing waits: the recording source settles at once, so the awaits resume in
 * the same task's microtask checkpoint, and the interval is main-thread execution only.
 */

export type WorkKind = 'doc' | 'view' | 'slot0' | 'slot1pre' | 'slot1post';
/** `[end, ms, kind]`: the probe's `performance.now()` at the end of the work, and its length. */
export type Work = readonly [number, number, WorkKind];

export const LOCAL_P95_MS = 16;
export const REMOTE_P95_MS = 136;
export const KEY_WORK_P95_MS = 2;

/** The key's kinds: its document update, its local completion work and the popup render. */
export const KEY_KINDS: readonly WorkKind[] = ['doc', 'view', 'slot0', 'slot1pre'];
const COMPLETION_KINDS: readonly WorkKind[] = ['slot0', 'slot1pre'];

export function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

export const summary = (xs: readonly number[]): { p50: number; p95: number; max: number } => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1) ?? 0 };
};

/** The entries of `work` that end in `[from, to]` and are of one of `kinds`. */
export const within = (
  work: readonly Work[],
  from: number,
  to: number,
  kinds: readonly WorkKind[],
): Work[] => work.filter(([t, , k]) => t >= from && t <= to && kinds.includes(k));

/** The length of the union of the entries' intervals `[end − ms, end]`. */
export function unionMs(ws: readonly Work[]): number {
  return ws.reduce((a, [, ms]) => a + ms, 0);
}

export interface KeyWork {
  /** The union of every `doc`, `view`, `slot0` and `slot1pre` interval of the key. */
  readonly keyWork: number;
  /** The key's document updates. */
  readonly docMs: number;
  /** The union of its `slot0` and `slot1pre` intervals. */
  readonly completionMs: number;
  readonly docs: number;
  readonly slot0s: number;
}

/** The work of the key whose keydown is at `from` and whose popup is at `to`. */
export function keyWorkOf(work: readonly Work[], from: number, to: number): KeyWork {
  const ws = within(work, from, to, KEY_KINDS);
  const docs = ws.filter(([, , k]) => k === 'doc');
  return {
    keyWork: unionMs(ws),
    docMs: unionMs(docs),
    completionMs: unionMs(ws.filter(([, , k]) => COMPLETION_KINDS.includes(k))),
    docs: docs.length,
    slot0s: ws.filter(([, , k]) => k === 'slot0').length,
  };
}

export interface GateInput {
  readonly local: { readonly p95: number };
  readonly remote: { readonly p95: number };
  readonly keyWork: { readonly p95: number };
  /** Main-thread tasks over 16 ms (PRF-005). */
  readonly over16: number;
}

/** The enforce thresholds `r` breaches, one line each. */
export function breaches(r: GateInput): string[] {
  const ms = (x: number) => x.toFixed(2);
  return [
    ...(r.local.p95 > LOCAL_P95_MS
      ? [`local p95 ${ms(r.local.p95)} ms > ${String(LOCAL_P95_MS)} ms (T09 §7)`]
      : []),
    ...(r.remote.p95 > REMOTE_P95_MS
      ? [`remote p95 ${ms(r.remote.p95)} ms > ${String(REMOTE_P95_MS)} ms (T09-007)`]
      : []),
    ...(r.over16 > 0 ? [`${String(r.over16)} main-thread tasks over 16 ms (PRF-005)`] : []),
    ...(r.keyWork.p95 > KEY_WORK_P95_MS
      ? [`keyWork p95 ${ms(r.keyWork.p95)} ms > ${String(KEY_WORK_P95_MS)} ms (T09 §7)`]
      : []),
  ];
}

/** `EDITOR_BENCH_GATE=enforce`: throws on any breach. Otherwise each breach is passed to `warn`. */
export function checkGate(
  bs: readonly string[],
  enforce: boolean,
  warn: (b: string) => void,
): void {
  if (enforce) {
    if (bs.length > 0) throw new Error(`enforce gate: ${bs.join('; ')}`);
    return;
  }
  for (const b of bs) warn(b);
}
