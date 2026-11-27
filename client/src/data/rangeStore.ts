/**
 * The page-wide range store (#304 §3.2, §4; ADR-0038): board PromQL range data held as buckets of
 * 256 grid points per identity (tenant, scope epoch, text, variables, rate chip, macro window,
 * step), shared across panels, pans, zooms and refreshes. A view's visible buckets are fetched
 * `interactive` and, for a line, one window either side `prefetch` (PRF-028); a pan of up to one
 * window paints from held data. Writes are ordered per bucket (§4.2), freshness is per bucket
 * (§4.3), scope changes drop the tenant and every cached read is bounded by a lease (§4.5), and
 * memory has hard bounds with a bypass to today's single request (§4.2, §4.7).
 *
 * Part B: the family of an identity (every step) fills a view's missing buckets as a rank 0
 * paint, a cold line view is fetched coarse first (width / 4) with the fine pass 120 ms later,
 * and a line view's zoom-out ladder (3×, 9×) is prefetched in the background.
 */
import type { Api } from '../api/Api';
import { isApiError } from '../api/types';
import { atStep, coarseStep, ladderOf } from '../boards/rangeView';
import type { TimeWindow } from '../engine/api';
import {
  bucketLastMs,
  bucketOf,
  bucketStartMs,
  bucketsOf,
  runsOf,
  BUCKET_STEPS,
  type Run,
} from './buckets';
import type { RangeResult, ScopeStamp } from './decode';
import { fillRange, type StepSource } from './rangeFill';
import { createScheduler, type RangeClass, type Scheduler } from './rangeScheduler';
import { mergeCompleteness, slice, spanBytes, stitch, type Part } from './rangeStitch';
import type { Grid } from './step';

export type { RangeClass, Part };
export { stitch };

export interface RangeIdentity {
  readonly tenant: string;
  /** The tenant's scope epoch when the view was planned (§4.5). */
  readonly scope: string;
  readonly text: string;
  readonly vars: string;
  readonly rate: boolean;
  /** The window the range macros see; null unless the text uses one. */
  readonly rangeMs: number | null;
  readonly stepMs: number;
}

export interface RangeView {
  readonly id: RangeIdentity;
  /** JSON of `id`'s fields in order. */
  readonly idKey: string;
  /** `promGrid(window, widthPx)`: today's visible grid. */
  readonly grid: Grid;
  readonly visible: Run;
  /** [] unless line (§4.1). */
  readonly flanks: readonly Run[];
  readonly windowMs: number;
  readonly epoch: number;
  readonly anchorMs: number;
  /** Sent as `width_px` (the server still validates it). */
  readonly widthPx: number;
  readonly line: boolean;
}

export interface Assembled {
  readonly held: RangeResult;
  readonly visible: RangeResult;
  /** The visible grid: the line's auto-fit window (§A.3). */
  readonly fit: TimeWindow;
  /** Held spans not fresh for the view (§4.3). */
  readonly stale: readonly TimeWindow[];
  /** 1: every visible bucket at the view's step; 0: a fill from other steps (Part B). */
  readonly rank: 0 | 1;
}

/** Admission refused (§4.2): the panel uses today's single request. */
export class StoreBypass extends Error {
  constructor(message = 'range store: admission refused') {
    super(message);
    this.name = 'StoreBypass';
  }
}

export type ScopeObservation = ScopeStamp;

export interface RangeStore {
  /** Resolves when every visible bucket is held and fresh; `StoreBypass` when not admitted. */
  load(owner: string, v: RangeView, signal?: AbortSignal): Promise<Assembled>;
  retain(owner: string, v: RangeView): void;
  release(owner: string): void;
  /** The assembly whenever every visible bucket is held (fresh or stale) and the lease is valid. */
  peek(v: RangeView): Assembled | null;
  /** `peek`, else the visible buckets with missing ones filled from the family (rank 0). */
  peekFilled(v: RangeView): Assembled | null;
  /** JSON of `stale` (for `useSyncExternalStore`). */
  staleSpans(v: RangeView): string;
  /** Every visible bucket is held and fresh for `v` (a load would issue no request). */
  fresh(v: RangeView): boolean;
  bypassed(idKey: string): boolean;
  scopeOf(tenant: string): string;
  /** A cached read is allowed: the current epoch was confirmed less than 5 min ago. */
  leaseValid(tenant: string): boolean;
  /** Order and lease (§4.5): `atMs` is the receipt time of the response or bootstrap. */
  observeScope(tenant: string, sc: ScopeObservation, atMs: number): void;
  dropTenant(tenant: string): void;
  /** Notifies the tenant's subscribers of a lease that has expired since the last tick. */
  tick(): void;
  /** `key`: an `idKey`, or a tenant. */
  subscribe(key: string, cb: () => void): () => void;
  /** Called with the tenant whenever its data is dropped (a scope change, `scope_denied`, a switch). */
  onDrop(cb: (tenant: string) => void): () => void;
  /** The store's clock (the lease's time base). */
  now(): number;
  stats(): {
    readonly bytes: number;
    readonly pinnedBytes: number;
    readonly assemblyBytes: number;
    readonly inFlight: number;
  };
  readonly scheduler: Scheduler;
  /** False: every range run takes today's single request (still through the scheduler). */
  readonly enabled: boolean;
}

/** Every stored segment, pinned included. */
export const STORE_BYTES = 128 << 20;
/** The stitched arrays of all retained views. */
export const ASSEMBLY_BYTES = 64 << 20;
/** Series × points of one view's held span. */
export const HELD_CELLS = 1 << 21;
/** A cached read is served only this long after the epoch was last confirmed (§4.5). */
export const LEASE_MS = 300_000;
/** A bucket that ends this long before its segment's anchor is settled (§4.3). */
export const SETTLED_MS = 300_000;
/** The data crossfade (ADR-0039, T02-007). */
export const FADE_MS = 150;
/** The fine pass follows the coarse one after the view is unchanged this long (T07-011). */
export const COARSE_DEBOUNCE_MS = 120;
/** A visible run is fetched at most this many times per load (responses discarded by scope). */
const LOAD_ATTEMPTS = 4;

export interface StoreDeps {
  readonly api: Pick<Api, 'queryRange'>;
  readonly scheduler?: Scheduler;
  /** Wall-clock ms (the lease); default `Date.now`. */
  readonly now?: () => number;
  /** False: the store holds nothing and every run is ineligible (a kill switch); default true. */
  readonly enabled?: boolean;
  /** The coarse pass's debounce timer; default `setTimeout`. */
  readonly timers?: {
    set(f: () => void, ms: number): unknown;
    clear(h: unknown): void;
  };
}

export function identityKey(id: RangeIdentity): string {
  return JSON.stringify([id.tenant, id.scope, id.text, id.vars, id.rate, id.rangeMs, id.stepMs]);
}

/** `idKey` without `stepMs`: every step of one query shares a family (Part B §3.1). */
export function familyKey(id: RangeIdentity): string {
  return JSON.stringify([id.tenant, id.scope, id.text, id.vars, id.rate, id.rangeMs]);
}

interface Segment {
  readonly seq: number;
  readonly idKey: string;
  readonly k0: number;
  readonly k1: number;
  readonly result: RangeResult;
  readonly bytes: number;
  readonly gen: number;
  readonly epoch: number;
  readonly anchorMs: number;
  /** Buckets that point at it; 0 → deleted. */
  refs: number;
  lastUse: number;
}

interface Ident {
  readonly idKey: string;
  readonly id: RangeIdentity;
  readonly family: string;
  readonly buckets: Map<number, Segment>;
  bypassed: boolean;
  /** The series count of the last stored response (bounds later runs, §A.9). */
  series: number | null;
  /** Flanks and the ladder stop after an admission refusal, until the identity's view changes. */
  flanksStopped: boolean;
}

type Purpose = 'visible' | 'flank' | 'ladder' | 'coarse';
type Outcome =
  | { readonly kind: 'stored' }
  | { readonly kind: 'discarded' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'bypass' }
  | { readonly kind: 'error'; readonly error: unknown };

interface JobState {
  readonly key: string;
  readonly ident: Ident;
  readonly run: Run;
  readonly epoch: number;
  readonly anchorMs: number;
  readonly purpose: Purpose;
  cancelled: boolean;
  readonly done: Promise<Outcome>;
  settle(o: Outcome): void;
}

interface TenantScope {
  epoch: string;
  seq: number;
  confirmedAt: number;
  readonly retired: Set<string>;
  /** The lease was valid at the last `tick`. */
  live: boolean;
}

interface CachedAssembly {
  readonly sig: string;
  readonly a: Assembled;
  readonly bytes: number;
}

interface PendingFine {
  readonly vk: string;
  readonly timer: unknown;
  readonly cancel: () => void;
}

const abortError = (): DOMException => new DOMException('cancelled', 'AbortError');

const settled = (k: number, s: Segment): boolean =>
  bucketLastMs(k, s.result.stepMs) < s.anchorMs - SETTLED_MS;

const fresh = (k: number, s: Segment, v: { epoch: number; anchorMs: number }): boolean =>
  s.epoch === v.epoch && (settled(k, s) || s.anchorMs === v.anchorMs);

const viewKey = (v: RangeView): string =>
  `${v.idKey}|${String(v.grid.startMs)}|${String(v.grid.endMs)}|${String(v.epoch)}|${String(v.anchorMs)}|${String(v.line)}`;

const runPoints = (r: Run): number => (r.k1 - r.k0) * BUCKET_STEPS;

export function createRangeStore(d: StoreDeps): RangeStore {
  const scheduler = d.scheduler ?? createScheduler();
  const now = d.now ?? Date.now;
  const timers = d.timers ?? {
    set: (f: () => void, ms: number): unknown => setTimeout(f, ms),
    clear: (h: unknown): void => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  };
  const idents = new Map<string, Ident>();
  const families = new Map<string, Set<string>>();
  const tenants = new Map<string, TenantScope>();
  const owners = new Map<string, RangeView>();
  const jobs = new Map<string, JobState>();
  const listeners = new Map<string, Set<() => void>>();
  const assemblies = new Map<string, CachedAssembly>();
  const fills = new Map<string, { readonly sig: string; readonly a: Assembled }>();
  const fines = new Map<string, PendingFine>();
  const releasing = new Set<string>();
  const dropListeners = new Set<(tenant: string) => void>();
  let bytes = 0;
  let assemblyBytes = 0;
  let gen = 0;
  let segSeq = 0;
  let useSeq = 0;

  const emit = (key: string): void => {
    const ls = listeners.get(key);
    if (ls === undefined) return;
    for (const cb of [...ls]) cb();
  };

  // ---------------------------------------------------------------------------------------------
  // Identities and segments

  const identOf = (id: RangeIdentity, idKey = identityKey(id)): Ident => {
    let i = idents.get(idKey);
    if (i === undefined) {
      i = {
        idKey,
        id,
        family: familyKey(id),
        buckets: new Map(),
        bypassed: false,
        series: null,
        flanksStopped: false,
      };
      idents.set(idKey, i);
      let f = families.get(i.family);
      if (f === undefined) {
        f = new Set();
        families.set(i.family, f);
      }
      f.add(idKey);
    }
    return i;
  };

  const unref = (s: Segment): void => {
    s.refs--;
    if (s.refs === 0) bytes -= s.bytes;
  };

  const dropIdent = (i: Ident): void => {
    for (const s of new Set(i.buckets.values())) if (s.refs > 0) bytes -= s.bytes;
    i.buckets.clear();
    idents.delete(i.idKey);
    families.get(i.family)?.delete(i.idKey);
    for (const [k, c] of assemblies) {
      if (!k.startsWith(i.idKey)) continue;
      assemblyBytes -= c.bytes;
      assemblies.delete(k);
    }
    for (const k of fills.keys()) if (k.startsWith(i.idKey)) fills.delete(k);
  };

  // ---------------------------------------------------------------------------------------------
  // Scope and lease (§4.5)

  const scopeOf = (tenant: string): string => tenants.get(tenant)?.epoch ?? '';

  const leaseValid = (tenant: string): boolean => {
    const t = tenants.get(tenant);
    return t !== undefined && now() - t.confirmedAt < LEASE_MS;
  };

  const cancelJob = (j: JobState): void => {
    if (j.cancelled) return;
    j.cancelled = true;
    jobs.delete(j.key);
    scheduler.cancel(j.key);
    j.settle({ kind: 'aborted' });
  };

  const dropData = (tenant: string): void => {
    for (const j of [...jobs.values()]) if (j.ident.id.tenant === tenant) cancelJob(j);
    const dropped: string[] = [];
    for (const i of [...idents.values()]) {
      if (i.id.tenant !== tenant) continue;
      dropIdent(i);
      dropped.push(i.idKey);
    }
    for (const cb of [...dropListeners]) cb(tenant);
    for (const k of dropped) emit(k);
  };

  const observeScope = (tenant: string, sc: ScopeObservation, atMs: number): void => {
    const t = tenants.get(tenant);
    if (t === undefined) {
      tenants.set(tenant, {
        epoch: sc.epoch,
        seq: sc.seq,
        confirmedAt: atMs,
        retired: new Set(),
        live: now() - atMs < LEASE_MS,
      });
      // Anything held under another scope before the first observation goes.
      if ([...idents.values()].some((i) => i.id.tenant === tenant && i.id.scope !== sc.epoch)) {
        dropData(tenant);
      }
      emit(tenant);
      return;
    }
    if (t.retired.has(sc.epoch) || sc.seq < t.seq) return;
    if (sc.epoch === t.epoch) {
      const was = leaseValid(tenant);
      t.confirmedAt = Math.max(t.confirmedAt, atMs);
      t.seq = Math.max(t.seq, sc.seq);
      if (!was && leaseValid(tenant)) {
        t.live = true;
        emit(tenant);
      }
      return;
    }
    // A newer epoch: the old one is retired for the session and the tenant's data goes.
    t.retired.add(t.epoch);
    t.epoch = sc.epoch;
    t.seq = sc.seq;
    t.confirmedAt = atMs;
    t.live = leaseValid(tenant);
    dropData(tenant);
    emit(tenant);
  };

  /** A response without scope headers (stub mode, an old BFF) confirms the current epoch. */
  const confirm = (tenant: string, epoch: string, atMs: number): void => {
    const t = tenants.get(tenant);
    if (t === undefined) observeScope(tenant, { epoch, seq: 0 }, atMs);
    else if (t.epoch === epoch) observeScope(tenant, { epoch, seq: t.seq }, atMs);
  };

  // ---------------------------------------------------------------------------------------------
  // Wanted buckets and cancellation (§4.6)

  /** The buckets a view wants, by identity: visible ∪ flanks, and Part B's coarse and ladder. */
  const wantedOf = (v: RangeView): Map<string, Set<number>> => {
    const out = new Map<string, Set<number>>();
    const add = (idKey: string, r: Run): void => {
      let s = out.get(idKey);
      if (s === undefined) {
        s = new Set();
        out.set(idKey, s);
      }
      for (let k = r.k0; k < r.k1; k++) s.add(k);
    };
    add(v.idKey, v.visible);
    for (const f of v.flanks) add(v.idKey, f);
    if (v.line) {
      const c = coarseStep(v, v.widthPx);
      if (c !== null) {
        add(identityKey(atStep(v, c, v.windowMs)), {
          k0: bucketOf(v.grid.startMs, c),
          k1: bucketOf(v.grid.endMs, c) + 1,
        });
      }
      for (const l of ladderOf(v, v.widthPx)) {
        add(identityKey(atStep(v, l.stepMs, l.factor * v.windowMs)), l.run);
      }
    }
    return out;
  };

  const wantedAll = (): Map<string, Set<number>> => {
    const all = new Map<string, Set<number>>();
    for (const v of owners.values()) {
      for (const [k, s] of wantedOf(v)) {
        let t = all.get(k);
        if (t === undefined) {
          t = new Set();
          all.set(k, t);
        }
        for (const x of s) t.add(x);
      }
    }
    return all;
  };

  /** Every job with no wanted bucket is cancelled in the same call (T04-013, T07-010). */
  const cancelUnwanted = (): void => {
    const wanted = wantedAll();
    for (const j of [...jobs.values()]) {
      const w = wanted.get(j.ident.idKey);
      let keep = false;
      if (w !== undefined) for (let k = j.run.k0; k < j.run.k1 && !keep; k++) keep = w.has(k);
      if (!keep) cancelJob(j);
    }
  };

  const pinned = (): Set<Segment> => {
    const out = new Set<Segment>();
    for (const [idKey, ks] of wantedAll()) {
      const i = idents.get(idKey);
      if (i === undefined) continue;
      for (const k of ks) {
        const s = i.buckets.get(k);
        if (s !== undefined) out.add(s);
      }
    }
    return out;
  };

  // ---------------------------------------------------------------------------------------------
  // Admission and writes (§4.2)

  /** Evicts unpinned segments, least recently used first, until `need` more bytes fit. */
  const makeRoom = (need: number): boolean => {
    if (bytes + need <= STORE_BYTES) return true;
    const pin = pinned();
    const free = new Set<Segment>();
    for (const i of idents.values()) {
      for (const s of i.buckets.values()) if (!pin.has(s)) free.add(s);
    }
    let freeable = 0;
    for (const s of free) freeable += s.bytes;
    if (bytes - freeable + need > STORE_BYTES) return false;
    for (const s of [...free].sort((a, b) => a.lastUse - b.lastUse)) {
      if (bytes + need <= STORE_BYTES) break;
      const i = idents.get(s.idKey);
      if (i === undefined) continue;
      for (const [k, x] of [...i.buckets]) {
        if (x !== s) continue;
        i.buckets.delete(k);
        unref(s);
      }
    }
    return bytes + need <= STORE_BYTES;
  };

  const write = (j: JobState, r: RangeResult, g: number): Outcome => {
    const i = j.ident;
    const points = runPoints(j.run);
    const refuse = (): Outcome => {
      if (j.purpose === 'visible') {
        i.bypassed = true;
        return { kind: 'bypass' };
      }
      i.flanksStopped = true;
      return { kind: 'discarded' };
    };
    if (
      r.stepMs !== i.id.stepMs ||
      r.startMs !== bucketStartMs(j.run.k0, i.id.stepMs) ||
      r.endMs !== bucketLastMs(j.run.k1 - 1, i.id.stepMs) ||
      r.series.some((s) => s.values.length !== points)
    ) {
      // Not the grid that was asked for: it cannot be stitched.
      return refuse();
    }
    if (r.series.length * points > HELD_CELLS) return refuse();
    const size = spanBytes(r.series.length, points);
    if (!makeRoom(size)) return refuse();
    const seg: Segment = {
      seq: ++segSeq,
      idKey: i.idKey,
      k0: j.run.k0,
      k1: j.run.k1,
      result: r,
      bytes: size,
      gen: g,
      epoch: j.epoch,
      anchorMs: j.anchorMs,
      refs: 0,
      lastUse: ++useSeq,
    };
    for (let k = j.run.k0; k < j.run.k1; k++) {
      const cur = i.buckets.get(k);
      if (
        cur !== undefined &&
        !(g >= cur.gen && j.epoch >= cur.epoch && j.anchorMs >= cur.anchorMs)
      ) {
        continue;
      }
      if (cur !== undefined) unref(cur);
      i.buckets.set(k, seg);
      seg.refs++;
    }
    if (seg.refs > 0) bytes += seg.bytes;
    i.series = r.series.length;
    return { kind: 'stored' };
  };

  // ---------------------------------------------------------------------------------------------
  // Jobs

  const jobKey = (i: Ident, r: Run, epoch: number, anchorMs: number): string =>
    `${i.idKey}|${String(r.k0)}|${String(r.k1)}|${String(epoch)}|${String(anchorMs)}`;

  /** A job of `i` in flight that will make bucket k fresh for `v`. */
  const coveringJob = (
    i: Ident,
    k: number,
    v: { epoch: number; anchorMs: number },
  ): JobState | null => {
    for (const j of jobs.values()) {
      if (j.ident !== i || k < j.run.k0 || k >= j.run.k1 || j.epoch !== v.epoch) continue;
      if (j.anchorMs === v.anchorMs || bucketLastMs(k, i.id.stepMs) < j.anchorMs - SETTLED_MS) {
        return j;
      }
    }
    return null;
  };

  // `advance` and `submit` call each other through stored responses.
  let advance: (v: RangeView) => void = () => undefined;

  const submit = (
    i: Ident,
    r: Run,
    v: { epoch: number; anchorMs: number; widthPx: number },
    cls: RangeClass,
    purpose: Purpose,
  ): JobState => {
    const key = jobKey(i, r, v.epoch, v.anchorMs);
    const existing = jobs.get(key);
    if (existing !== undefined) {
      scheduler.upgrade(key, cls);
      return existing;
    }
    // A newer job for the same run (epoch or anchor) cancels the older.
    for (const j of [...jobs.values()]) {
      if (j.ident === i && j.run.k0 === r.k0 && j.run.k1 === r.k1) cancelJob(j);
    }
    let settle: (o: Outcome) => void = () => undefined;
    const done = new Promise<Outcome>((res) => {
      settle = res;
    });
    const j: JobState = {
      key,
      ident: i,
      run: r,
      epoch: v.epoch,
      anchorMs: v.anchorMs,
      purpose,
      cancelled: false,
      done,
      settle: (o) => {
        settle(o);
      },
    };
    jobs.set(key, j);
    const id = i.id;
    scheduler.submit({
      key,
      cls,
      run: async (signal, priority) => {
        // `gen` is taken when the job starts (§4.2).
        const g = ++gen;
        let res: RangeResult;
        try {
          res = await d.api.queryRange(
            id.tenant,
            {
              query: id.text,
              fromMs: bucketStartMs(r.k0, id.stepMs),
              toMs: bucketLastMs(r.k1 - 1, id.stepMs),
              widthPx: Math.min(10_000, Math.max(1, Math.round(v.widthPx))),
              vars: Object.fromEntries(JSON.parse(id.vars) as [string, string][]),
              rate: id.rate,
              stepMs: id.stepMs,
              ...(id.rangeMs === null ? {} : { rangeMs: id.rangeMs }),
              priority,
            },
            signal,
          );
        } catch (e) {
          // Cancelled: settled already. Preempted: the scheduler runs it again.
          if (j.cancelled || signal.aborted) return;
          jobs.delete(key);
          if (isApiError(e) && e.scope !== null) observeScope(id.tenant, e.scope, now());
          if (isApiError(e, 'scopeDenied')) store.dropTenant(id.tenant);
          j.settle({ kind: 'error', error: e });
          emit(i.idKey);
          return;
        }
        // An aborted job's response is never stored (§4.2).
        if (j.cancelled || signal.aborted) return;
        jobs.delete(key);
        if (res.scope !== undefined && res.scope !== null) {
          observeScope(id.tenant, res.scope, now());
        } else confirm(id.tenant, id.scope, now());
        if (idents.get(i.idKey) !== i || (res.scope != null && res.scope.epoch !== id.scope)) {
          // Another scope's data is never stored (§4.5).
          j.settle({ kind: 'discarded' });
          return;
        }
        const o = write(j, res, g);
        j.settle(o);
        emit(i.idKey);
        for (const w of [...owners.values()]) {
          if (w.idKey === i.idKey || familyKey(w.id) === i.family) {
            if (w.idKey !== i.idKey) emit(w.idKey);
            advance(w);
          }
        }
      },
    });
    return j;
  };

  /** The flanks of a line view whose visible run is fresh, then its ladder (Part B). */
  advance = (v: RangeView): void => {
    if (!v.line || !leaseValid(v.id.tenant) || v.id.scope !== scopeOf(v.id.tenant)) return;
    const i = idents.get(v.idKey);
    if (i === undefined || i.bypassed || i.flanksStopped) return;
    const visibleFresh = bucketsOf(v.visible).every((k) => {
      const s = i.buckets.get(k);
      return s !== undefined && fresh(k, s, v);
    });
    if (!visibleFresh) return;
    let flanksDone = true;
    for (const f of v.flanks) {
      const need: number[] = [];
      for (let k = f.k0; k < f.k1; k++) {
        const s = i.buckets.get(k);
        if (s !== undefined && fresh(k, s, v)) continue;
        flanksDone = false;
        if (coveringJob(i, k, v) === null) need.push(k);
      }
      for (const r of runsOf(need)) {
        if (i.series !== null && i.series * runPoints(r) > HELD_CELLS) continue;
        submit(i, r, v, 'prefetch', 'flank');
      }
    }
    if (!flanksDone) return;
    for (const l of ladderOf(v, v.widthPx)) {
      if (i.series !== null && i.series * runPoints(l.run) > HELD_CELLS) continue;
      const li = identOf(atStep(v, l.stepMs, l.factor * v.windowMs));
      if (li.bypassed || li.flanksStopped) continue;
      const need = bucketsOf(l.run).filter((k) => {
        const s = li.buckets.get(k);
        return !(s !== undefined && fresh(k, s, v)) && coveringJob(li, k, v) === null;
      });
      for (const r of runsOf(need)) submit(li, r, v, 'background', 'ladder');
    }
  };

  // ---------------------------------------------------------------------------------------------
  // Assembly (§4.4)

  const unionSeries = (i: Ident, a: number, b: number): number => {
    const keys = new Set<string>();
    const segs = new Set<Segment>();
    for (let k = a; k < b; k++) {
      const s = i.buckets.get(k);
      if (s !== undefined) segs.add(s);
    }
    for (const s of segs) for (const x of s.result.series) keys.add(x.key);
    return keys.size;
  };

  /** The held run: the visible run plus contiguous held flank buckets, trimmed outermost first. */
  const heldRun = (v: RangeView, i: Ident): Run => {
    let k0 = v.visible.k0;
    let k1 = v.visible.k1;
    const left = v.flanks.find((f) => f.k1 === v.visible.k0);
    const right = v.flanks.find((f) => f.k0 === v.visible.k1);
    if (left !== undefined) while (k0 > left.k0 && i.buckets.has(k0 - 1)) k0--;
    if (right !== undefined) while (k1 < right.k1 && i.buckets.has(k1)) k1++;
    const fits = (a: number, b: number): boolean => {
      const n = unionSeries(i, a, b);
      const pts = (b - a) * BUCKET_STEPS;
      if (n * pts > HELD_CELLS) return false;
      const single = i.buckets.get(a);
      if (single !== undefined && single.k0 === a && single.k1 === b) return true;
      const prev = assemblies.get(`${i.idKey}|${String(a)}|${String(b)}`)?.bytes ?? 0;
      return assemblyBytes - prev + spanBytes(n, pts) <= ASSEMBLY_BYTES;
    };
    while ((k0 < v.visible.k0 || k1 > v.visible.k1) && !fits(k0, k1)) {
      if (v.visible.k0 - k0 >= k1 - v.visible.k1) k0++;
      else k1--;
    }
    return { k0, k1 };
  };

  const staleOf = (v: RangeView, i: Ident, h: Run): TimeWindow[] => {
    const out: TimeWindow[] = [];
    for (let k = h.k0; k < h.k1; k++) {
      const s = i.buckets.get(k);
      if (s === undefined || fresh(k, s, v)) continue;
      const fromMs = bucketStartMs(k, v.id.stepMs);
      const toMs = bucketLastMs(k, v.id.stepMs);
      const last = out.at(-1);
      if (last !== undefined && last.toMs + v.id.stepMs === fromMs) {
        out[out.length - 1] = { fromMs: last.fromMs, toMs };
      } else out.push({ fromMs, toMs });
    }
    return out;
  };

  const assemble = (v: RangeView, i: Ident): Assembled => {
    const h = heldRun(v, i);
    const parts: { k0: number; k1: number; seg: Segment }[] = [];
    for (let k = h.k0; k < h.k1; k++) {
      const s = i.buckets.get(k);
      if (s === undefined) throw new Error('range store: a held bucket is missing');
      s.lastUse = ++useSeq;
      const last = parts.at(-1);
      if (last?.seg === s) last.k1 = k + 1;
      else parts.push({ k0: k, k1: k + 1, seg: s });
    }
    const stale = staleOf(v, i, h);
    const sig = [
      parts.map((p) => `${String(p.seg.seq)}:${String(p.k0)}-${String(p.k1)}`).join(','),
      JSON.stringify(stale),
      String(v.grid.startMs),
      String(v.grid.endMs),
      scopeOf(v.id.tenant),
    ].join('|');
    const ak = `${i.idKey}|${String(h.k0)}|${String(h.k1)}`;
    const cached = assemblies.get(ak);
    if (cached?.sig === sig) return cached.a;
    const only = parts.length === 1 ? parts[0] : undefined;
    let held: RangeResult;
    let size = 0;
    if (only !== undefined && only.seg.k0 === h.k0 && only.seg.k1 === h.k1) {
      // One segment is the held span: its series by identity (by reference on MT, ADR-0034).
      held = only.seg.result;
    } else {
      held = stitch(
        parts.map((p) => ({ k0: p.k0, k1: p.k1, result: p.seg.result })),
        h.k0,
        h.k1,
        v.id.stepMs,
      );
      size = spanBytes(held.series.length, (h.k1 - h.k0) * BUCKET_STEPS);
    }
    const kEnd = bucketOf(v.grid.endMs, v.id.stepMs);
    const visibleParts = parts.filter((p) => p.k1 > v.visible.k0 && p.k0 < v.visible.k1);
    const end =
      (parts.find((p) => kEnd >= p.k0 && kEnd < p.k1) ?? parts.at(-1))?.seg.result ?? held;
    const completeness = mergeCompleteness(
      visibleParts.map((p) => p.seg.result),
      end,
    );
    const a: Assembled = {
      held,
      visible: slice(held, v.grid.startMs, v.grid.endMs, completeness, end.planned),
      fit: { fromMs: v.grid.startMs, toMs: v.grid.endMs },
      stale,
      rank: 1,
    };
    if (cached !== undefined) assemblyBytes -= cached.bytes;
    assemblies.set(ak, { sig, a, bytes: size });
    assemblyBytes += size;
    return a;
  };

  /** Assemblies of spans no retained view holds go. */
  const gcAssemblies = (): void => {
    const live = new Set<string>();
    for (const v of owners.values()) {
      const i = idents.get(v.idKey);
      if (i === undefined) continue;
      const h = heldRun(v, i);
      live.add(`${i.idKey}|${String(h.k0)}|${String(h.k1)}`);
    }
    for (const [k, c] of assemblies) {
      if (live.has(k)) continue;
      assemblyBytes -= c.bytes;
      assemblies.delete(k);
    }
  };

  const allHeld = (v: RangeView, i: Ident): boolean =>
    bucketsOf(v.visible).every((k) => i.buckets.has(k));

  /** A cached read: only under the current epoch and a valid lease (§4.5). */
  const readable = (v: RangeView): boolean =>
    leaseValid(v.id.tenant) && v.id.scope === scopeOf(v.id.tenant);

  const peek = (v: RangeView): Assembled | null => {
    if (!readable(v)) return null;
    const i = idents.get(v.idKey);
    if (i === undefined || i.bypassed || !allHeld(v, i)) return null;
    return assemble(v, i);
  };

  const peekFilled = (v: RangeView): Assembled | null => {
    const p = peek(v);
    if (p !== null) return p;
    if (!readable(v)) return null;
    const i = idents.get(v.idKey);
    if (i?.bypassed === true) return null;
    const own = new Map<number, RangeResult>();
    if (i !== undefined) {
      for (let k = v.visible.k0; k < v.visible.k1; k++) {
        const s = i.buckets.get(k);
        if (s !== undefined) own.set(k, s.result);
      }
    }
    const others: StepSource[] = [];
    const sigs: string[] = [];
    for (const idKey of families.get(familyKey(v.id)) ?? []) {
      const o = idents.get(idKey);
      if (o === undefined || o === i || o.buckets.size === 0) continue;
      const m = new Map<number, RangeResult>();
      for (const [k, s] of o.buckets) m.set(k, s.result);
      others.push({ stepMs: o.id.stepMs, buckets: m });
      sigs.push(`${idKey}:${[...new Set(o.buckets.values())].map((s) => String(s.seq)).join('.')}`);
    }
    if (own.size === 0 && others.length === 0) return null;
    const sig = `${[...own.values()].map((r) => r.startMs).join('.')}|${sigs.join(',')}`;
    const vk = viewKey(v);
    const c = fills.get(vk);
    if (c?.sig === sig) return c.a;
    const f = fillRange({ stepMs: v.id.stepMs, k0: v.visible.k0, k1: v.visible.k1, own, others });
    if (own.size === 0 && f.sources.every((s) => s === null)) return null;
    const ts = f.result.series[0]?.timestamps ?? new Float64Array(0);
    let lo = 0;
    while (lo < ts.length && (ts[lo] ?? 0) < v.grid.startMs) lo++;
    let hi = lo;
    while (hi < ts.length && (ts[hi] ?? 0) <= v.grid.endMs) hi++;
    const visibleSeries = f.result.series
      .map((s, si) => ({ s, m: f.result.absent?.[si] ?? null }))
      .filter(({ m }) => m === null || m.subarray(lo, hi).some((x) => x === 0))
      .map(({ s }) => ({
        ...s,
        timestamps: s.timestamps.subarray(lo, hi),
        values: s.values.subarray(lo, hi),
      }));
    const r = f.result;
    const a: Assembled = {
      held: r,
      visible: {
        planned: r.planned,
        startMs: v.grid.startMs,
        endMs: v.grid.endMs,
        stepMs: r.stepMs,
        series: visibleSeries,
        completeness: r.completeness,
      },
      fit: { fromMs: v.grid.startMs, toMs: v.grid.endMs },
      stale: [],
      rank: f.rank,
    };
    fills.set(vk, { sig, a });
    if (fills.size > 256) {
      const first = fills.keys().next().value;
      if (first !== undefined) fills.delete(first);
    }
    return a;
  };

  // ---------------------------------------------------------------------------------------------
  // Load (§4.1, §4.3; Part B §4.1)

  const waitAll = async (
    js: readonly JobState[],
    signal: AbortSignal | undefined,
  ): Promise<Outcome[]> => {
    const all = Promise.all(js.map((j) => j.done));
    if (signal === undefined) return all;
    if (signal.aborted) throw abortError();
    return new Promise<Outcome[]>((resolve, reject) => {
      const onAbort = (): void => {
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void all.then((o) => {
        signal.removeEventListener('abort', onAbort);
        resolve(o);
      });
    });
  };

  const clearFine = (owner: string): void => {
    const f = fines.get(owner);
    if (f === undefined) return;
    timers.clear(f.timer);
    fines.delete(owner);
    f.cancel();
  };

  /** Part B: a cold line view's fine run waits 120 ms behind the coarse paint (T07-011). */
  const debounced = (owner: string, v: RangeView, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      clearFine(owner);
      const vk = viewKey(v);
      const onAbort = (): void => {
        if (fines.get(owner)?.vk === vk) clearFine(owner);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = timers.set(() => {
        signal?.removeEventListener('abort', onAbort);
        fines.delete(owner);
        const o = owners.get(owner);
        if (o !== undefined && viewKey(o) !== vk) reject(abortError());
        else resolve();
      }, COARSE_DEBOUNCE_MS);
      fines.set(owner, {
        vk,
        timer,
        cancel: () => {
          signal?.removeEventListener('abort', onAbort);
          reject(abortError());
        },
      });
    });

  const load = async (owner: string, v: RangeView, signal?: AbortSignal): Promise<Assembled> => {
    const tenant = v.id.tenant;
    // Past the lease, the visible run is fetched before any cached paint (§4.5).
    let forced = !leaseValid(tenant);
    let coarseDone = false;
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      if (signal?.aborted === true) throw abortError();
      if (tenants.has(tenant) && v.id.scope !== scopeOf(tenant)) throw abortError();
      const i = identOf(v.id, v.idKey);
      if (i.bypassed) throw new StoreBypass();
      const visible = bucketsOf(v.visible);
      const stale = forced
        ? visible
        : visible.filter((k) => {
            const s = i.buckets.get(k);
            return s === undefined || !fresh(k, s, v);
          });
      if (stale.length === 0) {
        const a = peek(v);
        if (a !== null) {
          advance(v);
          return a;
        }
        forced = true;
        continue;
      }
      const waiting: JobState[] = [];
      const need: number[] = [];
      for (const k of stale) {
        // A job in flight answers after the lease expired too: its response renews it (§4.5).
        const j = coveringJob(i, k, v);
        if (j === null) need.push(k);
        else {
          scheduler.upgrade(j.key, 'interactive');
          if (!waiting.includes(j)) waiting.push(j);
        }
      }
      let cls: RangeClass = 'interactive';
      if (
        !coarseDone &&
        v.line &&
        waiting.length === 0 &&
        visible.every((k) => !i.buckets.has(k))
      ) {
        // Cold (Part B §4.1): coarse first unless the family fills every missing bucket.
        coarseDone = true;
        const c = coarseStep(v, v.widthPx);
        if (c !== null && !fullyFilled(v)) {
          const ci = identOf(atStep(v, c, v.windowMs));
          const cr = { k0: bucketOf(v.grid.startMs, c), k1: bucketOf(v.grid.endMs, c) + 1 };
          if (!ci.bypassed) {
            for (const r of runsOf(bucketsOf(cr))) submit(ci, r, v, 'interactive', 'coarse');
          }
          await debounced(owner, v, signal);
          cls = 'refine';
        }
      }
      for (const r of runsOf(need)) waiting.push(submit(i, r, v, cls, 'visible'));
      const outcomes = await waitAll(waiting, signal);
      for (const o of outcomes) {
        if (o.kind === 'error') throw o.error;
        if (o.kind === 'bypass') throw new StoreBypass();
      }
      if (outcomes.some((o) => o.kind === 'aborted')) {
        const mine = owners.get(owner);
        if (mine !== undefined && viewKey(mine) !== viewKey(v)) throw abortError();
      }
      forced = false;
    }
    const a = peek(v);
    if (a !== null) return a;
    throw abortError();
  };

  /** Every missing visible bucket of `v` is filled from another step (no gap). */
  const fullyFilled = (v: RangeView): boolean => {
    const i = idents.get(v.idKey);
    const own = new Map<number, RangeResult>();
    if (i !== undefined) {
      for (let k = v.visible.k0; k < v.visible.k1; k++) {
        const s = i.buckets.get(k);
        if (s !== undefined) own.set(k, s.result);
      }
    }
    const others: StepSource[] = [];
    for (const idKey of families.get(familyKey(v.id)) ?? []) {
      const o = idents.get(idKey);
      if (o === undefined || o === i || o.buckets.size === 0) continue;
      const m = new Map<number, RangeResult>();
      for (const [k, s] of o.buckets) m.set(k, s.result);
      others.push({ stepMs: o.id.stepMs, buckets: m });
    }
    const f = fillRange({ stepMs: v.id.stepMs, k0: v.visible.k0, k1: v.visible.k1, own, others });
    return f.sources.every((s) => s !== null);
  };

  // ---------------------------------------------------------------------------------------------
  // The store

  const store: RangeStore = {
    load,
    retain(owner, v) {
      releasing.delete(owner);
      const prev = owners.get(owner);
      owners.set(owner, v);
      if (prev !== undefined && viewKey(prev) !== viewKey(v)) {
        if (fines.get(owner)?.vk !== viewKey(v)) clearFine(owner);
        const i = idents.get(v.idKey);
        if (i !== undefined && prev.idKey !== v.idKey) i.flanksStopped = false;
      }
      cancelUnwanted();
      advance(v);
      gcAssemblies();
    },
    release(owner) {
      // A StrictMode replay (cleanup, then setup) retains again in the same task: no cancel.
      releasing.add(owner);
      queueMicrotask(() => {
        if (!releasing.has(owner)) return;
        releasing.delete(owner);
        owners.delete(owner);
        clearFine(owner);
        cancelUnwanted();
        gcAssemblies();
      });
    },
    peek,
    peekFilled,
    staleSpans(v) {
      if (!readable(v)) return '[]';
      const i = idents.get(v.idKey);
      if (i === undefined || !allHeld(v, i)) return '[]';
      const s = staleOf(v, i, heldRun(v, i));
      return s.length === 0 ? '[]' : JSON.stringify(s);
    },
    fresh(v) {
      if (!readable(v)) return false;
      const i = idents.get(v.idKey);
      if (i === undefined) return false;
      return bucketsOf(v.visible).every((k) => {
        const s = i.buckets.get(k);
        return s !== undefined && fresh(k, s, v);
      });
    },
    bypassed: (idKey) => idents.get(idKey)?.bypassed === true,
    scopeOf,
    leaseValid,
    observeScope,
    dropTenant(tenant) {
      dropData(tenant);
      emit(tenant);
    },
    tick() {
      for (const [tenant, t] of tenants) {
        const live = leaseValid(tenant);
        if (t.live && !live) {
          t.live = false;
          emit(tenant);
        } else if (live) t.live = true;
      }
    },
    onDrop(cb) {
      dropListeners.add(cb);
      return () => {
        dropListeners.delete(cb);
      };
    },
    now,
    subscribe(key, cb) {
      let ls = listeners.get(key);
      if (ls === undefined) {
        ls = new Set();
        listeners.set(key, ls);
      }
      ls.add(cb);
      return () => {
        ls.delete(cb);
        if (ls.size === 0) listeners.delete(key);
      };
    },
    stats() {
      let pinnedBytes = 0;
      for (const s of pinned()) pinnedBytes += s.bytes;
      return { bytes, pinnedBytes, assemblyBytes, inFlight: scheduler.stats().inFlight };
    },
    scheduler,
    enabled: d.enabled ?? true,
  };
  return store;
}
