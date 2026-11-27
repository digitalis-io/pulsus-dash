import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/types';
import { planRangeView } from '../boards/rangeView';
import { drain, fn, gridResult, scriptedRange, type FnSeries } from '../test/rangeApi';
import { bucketLastMs, bucketStartMs } from './buckets';
import { createScheduler } from './rangeScheduler';
import {
  ASSEMBLY_BYTES,
  LEASE_MS,
  STORE_BYTES,
  StoreBypass,
  createRangeStore,
  stitch,
  type RangeStore,
  type RangeView,
} from './rangeStore';

const H = 3_600_000;
const STEP = 15_000;
/** One bucket at the 15 s step: 256 × 15 s. */
const B = 3_840_000;
const FAR = 1_000 * B;

interface ViewOpts {
  readonly fromMs: number;
  readonly toMs: number;
  readonly line?: boolean;
  readonly epoch?: number;
  readonly anchorMs?: number;
  readonly scope?: string;
  readonly text?: string;
  readonly widthPx?: number;
}

function view(o: ViewOpts): RangeView {
  const v = planRangeView({
    tenant: 'demo',
    scope: o.scope ?? 'A',
    text: o.text ?? 'up',
    vars: '[]',
    rate: true,
    line: o.line ?? false,
    window: { fromMs: o.fromMs, toMs: o.toMs },
    widthPx: o.widthPx ?? 1200,
    epoch: o.epoch ?? 0,
    anchorMs: o.anchorMs ?? FAR,
  });
  if (v === null) throw new Error('no view');
  return v;
}

function setup(nowStart = 1_000_000) {
  const api = scriptedRange();
  const clock = { t: nowStart };
  const store = createRangeStore({ api, scheduler: createScheduler(), now: () => clock.t });
  store.observeScope('demo', { epoch: 'A', seq: 1 }, clock.t);
  return { api, clock, store };
}

const A1 = { epoch: 'A', seq: 1 };
const keys = (r: { series: readonly { labels: Readonly<Record<string, string>> }[] }) =>
  r.series.map((s) => Object.values(s.labels).join(','));

/** W1: buckets 10 (visible) with flanks 9 and 11 (§4.1). */
const W1 = { fromMs: 10 * B, toMs: 10 * B + H };

describe('rangeStore assembly (#304 §4.4)', () => {
  it('assemble one segment', async () => {
    const { api, store } = setup();
    const v = view(W1);
    expect(v.visible).toEqual({ k0: 10, k1: 11 });
    const p = store.load('o', v);
    await drain();
    expect(api.calls).toHaveLength(1);
    const c = api.calls[0];
    expect(c?.req.stepMs).toBe(STEP);
    expect(c?.req.fromMs).toBe(bucketStartMs(10, STEP));
    expect(c?.req.toMs).toBe(bucketLastMs(10, STEP));
    const r = c?.respond({ series: [fn({ a: '1' }, () => 1)], scope: A1 });
    const a = await p;
    expect(a.held.series).toBe(r?.series);
    expect(a.fit).toEqual({ fromMs: v.grid.startMs, toMs: v.grid.endMs });
    expect(a.visible.startMs).toBe(v.grid.startMs);
    expect(a.visible.endMs).toBe(v.grid.endMs);
    expect(a.visible.series[0]?.timestamps.length).toBe(241);
  });

  it('assemble stitched', () => {
    const g1 = { startMs: 0, endMs: bucketLastMs(2, STEP), stepMs: STEP };
    const g2 = { startMs: bucketStartMs(3, STEP), endMs: bucketLastMs(4, STEP), stepMs: STEP };
    const r1 = gridResult(g1, 'up', { series: [fn({ s: 'A' }, (t) => t / 1000)] });
    const r2 = gridResult(g2, 'up', {
      series: [fn({ s: 'A' }, (t) => t / 1000), fn({ s: 'B' }, () => 7)],
    });
    const held = stitch(
      [
        { k0: 0, k1: 3, result: r1 },
        { k0: 3, k1: 5, result: r2 },
      ],
      0,
      5,
      STEP,
    );
    expect(held.series).toHaveLength(2);
    const [a, b] = held.series;
    expect(a?.timestamps.length).toBe(1280);
    expect(a?.timestamps).toBe(b?.timestamps);
    expect(a?.values[768]).toBe(r2.series[0]?.values[0]);
    expect(a?.timestamps[768]).toBe(r2.series[0]?.timestamps[0]);
    expect(Array.from(b?.values.subarray(0, 768) ?? []).every(Number.isNaN)).toBe(true);
    expect(b?.values[768]).toBe(7);
    const mb = held.absent?.[1];
    expect(mb?.subarray(0, 768).every((x) => x === 1)).toBe(true);
    expect(mb?.subarray(768).every((x) => x === 0)).toBe(true);
    expect(held.absent?.[0] ?? null).toBeNull();
  });

  it('presence across a seam', async () => {
    const { api, store } = setup();
    const v = view({ ...W1, line: true });
    expect(v.flanks).toEqual([
      { k0: 9, k1: 10 },
      { k0: 11, k1: 12 },
    ]);
    const P = fn({ s: 'P' }, () => NaN);
    const Q = fn({ s: 'Q' }, (t) => (t < 10 * B ? 1 : null));
    const F = fn({ s: 'F' }, (t) => (t >= 11 * B ? 2 : null));
    const answer = (from: number, to: number) => ({
      series: [P, Q, F].filter((s) => {
        for (let t = from; t <= to; t += STEP) if (s.at(t) !== null) return true;
        return false;
      }),
      scope: A1,
    });
    api.auto = (c) => answer(c.req.fromMs, c.req.toMs);
    store.retain('o', v);
    const a = await store.load('o', v);
    await drain();
    expect(api.calls).toHaveLength(3);
    const now = store.peek(v);
    expect(now).not.toBeNull();
    expect(keys(now?.visible ?? a.visible)).toEqual(['P']);
    expect(keys(now?.held ?? a.held).sort()).toEqual(['F', 'P', 'Q']);
    // Pan one window right: F is in the visible slice now.
    const panned = view({ fromMs: W1.fromMs + H, toMs: W1.toMs + H, line: true });
    const p2 = store.peek(panned);
    expect(p2).not.toBeNull();
    expect(keys(p2?.visible ?? a.visible).sort()).toEqual(['F', 'P']);
  });

  it('completeness merge', async () => {
    const { api, store } = setup();
    const v0 = view(W1);
    const p0 = store.load('o', v0);
    await drain();
    api.calls[0]?.respond({
      series: [fn({ a: '1' }, () => 1)],
      scope: A1,
      completeness: { truncated: true, warnings: ['w1'], queryId: 'q1' },
    });
    await p0;
    const v = view({ fromMs: 10 * B + B / 2, toMs: 11 * B + B / 2 });
    expect(v.visible).toEqual({ k0: 10, k1: 12 });
    const p = store.load('o', v);
    await drain();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.req.fromMs).toBe(bucketStartMs(11, STEP));
    api.calls[1]?.respond({
      series: [fn({ a: '1' }, () => 1)],
      scope: A1,
      completeness: { warnings: ['w2'], queryId: 'q2' },
    });
    const a = await p;
    expect(a.visible.completeness.truncated).toBe(true);
    expect(a.visible.completeness.warnings).toEqual(['w1', 'w2']);
    expect(a.visible.completeness.queryId).toBe('q2');
  });
});

describe('rangeStore freshness (#304 §4.3)', () => {
  const A0 = 20 * B + 3_000_000;
  const live = (dt: number, epoch = 0) =>
    view({ fromMs: A0 - H + dt, toMs: A0 + dt, anchorMs: A0 + dt, epoch });

  it('freshness and stale spans', async () => {
    const { api, store } = setup();
    api.auto = () => ({ series: [fn({ a: '1' }, () => 1)], scope: A1 });
    const v1 = live(0);
    expect(v1.visible).toEqual({ k0: 19, k1: 21 });
    await store.load('o', v1);
    expect(api.calls).toHaveLength(1);
    expect(store.staleSpans(v1)).toBe('[]');

    // A relative refresh 5 s later: only the volatile bucket 20 refetches.
    const v2 = live(5_000);
    expect(store.peek(v2)).not.toBeNull();
    expect(JSON.parse(store.staleSpans(v2))).toEqual([
      { fromMs: bucketStartMs(20, STEP), toMs: bucketLastMs(20, STEP) },
    ]);
    api.auto = null;
    const p2 = store.load('o', v2);
    await drain();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.req.fromMs).toBe(bucketStartMs(20, STEP));
    expect(api.calls[1]?.req.toMs).toBe(bucketLastMs(20, STEP));
    api.calls[1]?.respond({ series: [fn({ a: '1' }, () => 2)], scope: A1 });
    await p2;
    expect(store.staleSpans(v2)).toBe('[]');

    // Refresh now (epoch + 1): every held span is stale until the refetch lands.
    const v3 = live(5_000, 1);
    expect(JSON.parse(store.staleSpans(v3))).toEqual([
      { fromMs: bucketStartMs(19, STEP), toMs: bucketLastMs(20, STEP) },
    ]);
    let done = false;
    const p3 = store.load('o', v3).then((a) => {
      done = true;
      return a;
    });
    await drain();
    expect(done).toBe(false);
    expect(api.calls).toHaveLength(3);
    api.calls[2]?.respond({ series: [fn({ a: '1' }, () => 3)], scope: A1 });
    await p3;
    expect(store.staleSpans(v3)).toBe('[]');

    // A pan within the held buckets: nothing stale, nothing fetched.
    const v4 = view({ fromMs: A0 - H - 1_800_000 + 5_000, toMs: A0 - 1_800_000 + 5_000, anchorMs: A0 + 5_000, epoch: 1 });
    expect(store.staleSpans(v4)).toBe('[]');
    await store.load('o', v4);
    expect(api.calls).toHaveLength(3);
  });

  it('cancelled response discarded', async () => {
    const { api, store } = setup();
    api.ignoreAbort = true;
    const a = view(W1);
    store.retain('o', a);
    void store.load('o', a).catch(() => undefined);
    await drain();
    expect(api.calls).toHaveLength(1);
    store.retain('o', view({ fromMs: 50 * B, toMs: 50 * B + H }));
    expect(api.calls[0]?.signal?.aborted).toBe(true);
    api.calls[0]?.respond({ series: [fn({ a: '1' }, () => 1)], scope: A1 });
    await drain();
    expect(store.stats().bytes).toBe(0);
    expect(store.peek(a)).toBeNull();
  });

  it('reverse-order refresh', async () => {
    const { api, store } = setup();
    const v1 = live(0);
    const v2 = view({ fromMs: A0 - H + B, toMs: A0 + B, anchorMs: A0 + B });
    expect(v2.visible).toEqual({ k0: 20, k1: 22 });
    store.retain('o1', v1);
    store.retain('o2', v2);
    const p1 = store.load('o1', v1);
    const p2 = store.load('o2', v2);
    await drain();
    expect(api.calls).toHaveLength(2);
    const [c1, c2] = api.calls;
    c2?.respond({ series: [fn({ a: '1' }, () => 2)], scope: A1 });
    await p2;
    c1?.respond({ series: [fn({ a: '1' }, () => 1)], scope: A1 });
    await p1;
    const a = store.peek(v1);
    const s = a?.held.series[0];
    const at = (t: number) => s?.values[(t - (a?.held.startMs ?? 0)) / STEP];
    expect(at(bucketStartMs(19, STEP))).toBe(1);
    expect(at(bucketStartMs(20, STEP))).toBe(2);
    expect(at(bucketLastMs(20, STEP))).toBe(2);
  });
});

describe('rangeStore scope (#304 §4.5, ADR-0038)', () => {
  const both: FnSeries[] = [fn({ team: 'a' }, () => 1), fn({ team: 'b' }, () => 2)];

  it('scope narrowed in session', async () => {
    const { api, store } = setup();
    api.auto = () => ({ series: both, scope: A1 });
    const v = view({ ...W1, line: true });
    store.retain('o', v);
    await store.load('o', v);
    await drain();
    expect(api.calls).toHaveLength(3);
    api.auto = null;
    // The server narrows; a pan before any response paints the cached A data (within the lease).
    const pan = view({ fromMs: W1.fromMs + H, toMs: W1.toMs + H, line: true });
    const cached = store.peek(pan);
    expect(cached).not.toBeNull();
    expect(keys(cached?.visible ?? { series: [] }).sort()).toEqual(['a', 'b']);
    store.retain('o', pan);
    await drain();
    const flank = api.open().at(-1);
    expect(flank).toBeDefined();
    let events = 0;
    store.subscribe('demo', () => {
      events++;
    });
    flank?.respond({ series: [both[0] as FnSeries], scope: { epoch: 'B', seq: 2 } });
    await drain();
    expect(events).toBeGreaterThan(0);
    expect(store.scopeOf('demo')).toBe('B');
    expect(store.peek(pan)).toBeNull();
    expect(store.stats().bytes).toBe(0);
    const again = view({ fromMs: W1.fromMs + H, toMs: W1.toMs + H, line: true, scope: 'B' });
    expect(store.peek(again)).toBeNull();
  });

  it('scope lease', async () => {
    const { api, clock, store } = setup();
    api.auto = () => ({ series: both, scope: A1 });
    const v = view({ ...W1, line: true });
    store.retain('o', v);
    await store.load('o', v);
    await drain();
    expect(api.calls).toHaveLength(3);
    api.auto = null;
    clock.t += LEASE_MS + 1;
    expect(store.leaseValid('demo')).toBe(false);
    const pan = view({ fromMs: W1.fromMs + H, toMs: W1.toMs + H, line: true });
    expect(store.peek(pan)).toBeNull();
    store.retain('o', pan);
    const p = store.load('o', pan);
    await drain();
    const visible = api.open().filter((c) => c.req.priority === 'high');
    expect(visible).toHaveLength(1);
    expect(visible[0]?.req.fromMs).toBe(bucketStartMs(pan.visible.k0, STEP));
    expect(visible[0]?.req.toMs).toBe(bucketLastMs(pan.visible.k1 - 1, STEP));
    visible[0]?.respond({ series: both, scope: A1 });
    const a = await p;
    expect(store.leaseValid('demo')).toBe(true);
    // The renewed lease serves the held flanks again.
    expect(a.held.startMs).toBeLessThan(pan.grid.startMs);
  });

  it('scope no rollback', async () => {
    const { api, store } = setup();
    store.observeScope('demo', { epoch: 'B', seq: 2 }, 1_000_000);
    expect(store.scopeOf('demo')).toBe('B');
    const v = view({ ...W1, scope: 'B' });
    const p = store.load('o', v);
    await drain();
    api.calls[0]?.respond({ series: both, scope: { epoch: 'B', seq: 2 } });
    await p;
    const bytes = store.stats().bytes;
    expect(bytes).toBeGreaterThan(0);
    // A stale bootstrap render with A.
    store.observeScope('demo', A1, 1_000_001);
    expect(store.scopeOf('demo')).toBe('B');
    expect(store.stats().bytes).toBe(bytes);
    // A late response with A after B: ignored, its data discarded.
    const w = view({ fromMs: 30 * B, toMs: 30 * B + H, scope: 'B' });
    const pw = store.load('o', w);
    await drain();
    api.calls[1]?.respond({ series: [fn({ team: 'c' }, () => 3)], scope: A1 });
    await drain();
    expect(store.scopeOf('demo')).toBe('B');
    expect(store.peek(w)).toBeNull();
    api.open()[0]?.respond({ series: both, scope: { epoch: 'B', seq: 2 } });
    const a = await pw;
    expect(keys(a.visible).sort()).toEqual(['a', 'b']);
  });

  it('scope denied', async () => {
    const { api, store } = setup();
    api.auto = () => ({ series: both, scope: A1 });
    const v = view(W1);
    await store.load('o', v);
    expect(store.peek(v)).not.toBeNull();
    let dropped = 0;
    store.subscribe('demo', () => {
      dropped++;
    });
    api.auto = null;
    const w = view({ fromMs: 30 * B, toMs: 30 * B + H });
    const p = store.load('o', w);
    await drain();
    api.calls[1]?.reject(new ApiError('scopeDenied', 'data scope denied'));
    await expect(p).rejects.toBeInstanceOf(ApiError);
    expect(dropped).toBeGreaterThan(0);
    expect(store.peek(v)).toBeNull();
    expect(store.stats().bytes).toBe(0);
  });
});

describe('rangeStore memory (#304 §4.2, §4.7)', () => {
  it('oversized view bypasses', async () => {
    const { api, store } = setup();
    const v = view({ fromMs: 10 * B, toMs: 10 * B + 1_200 * STEP });
    expect(v.visible.k1 - v.visible.k0).toBe(5);
    const many: FnSeries[] = Array.from({ length: 2_000 }, (_, i) =>
      fn({ i: String(i) }, () => i),
    );
    const p = store.load('o', v);
    await drain();
    api.calls[0]?.respond({ series: many, scope: A1 });
    await expect(p).rejects.toBeInstanceOf(StoreBypass);
    expect(store.bypassed(v.idKey)).toBe(true);
    expect(store.stats().bytes).toBe(0);
    await expect(store.load('o', v)).rejects.toBeInstanceOf(StoreBypass);
    expect(api.calls).toHaveLength(1);
  });

  it('many retained panels', async () => {
    const { api, store } = setup();
    // 300 series × 1 280 points ≈ 3 MiB a view; one shared array keeps the test small.
    const labels = Array.from({ length: 300 }, (_, i) => ({ i: String(i) }));
    const series: FnSeries[] = labels.map((l) => fn(l, () => 1));
    api.auto = () => ({ series, scope: A1 });
    let bypassed = 0;
    for (let n = 0; n < 60; n++) {
      const v = view({ fromMs: 10 * B, toMs: 10 * B + 1_200 * STEP, text: `up{n="${String(n)}"}` });
      store.retain(`o${String(n)}`, v);
      try {
        await store.load(`o${String(n)}`, v);
      } catch (e) {
        expect(e).toBeInstanceOf(StoreBypass);
        bypassed++;
      }
      const st = store.stats();
      expect(st.bytes).toBeLessThanOrEqual(STORE_BYTES);
      expect(st.assemblyBytes).toBeLessThanOrEqual(ASSEMBLY_BYTES);
    }
    expect(bypassed).toBeGreaterThan(0);
    expect(store.stats().pinnedBytes).toBeLessThanOrEqual(STORE_BYTES);
  });
});

describe('rangeStore ranks and ladder (#304 Part B §4.1)', () => {
  function timers() {
    let now = 0;
    const q: { at: number; f: () => void; id: number }[] = [];
    let id = 0;
    return {
      set(f: () => void, ms: number) {
        q.push({ at: now + ms, f, id: ++id });
        return id;
      },
      clear(h: unknown) {
        const i = q.findIndex((x) => x.id === h);
        if (i >= 0) q.splice(i, 1);
      },
      advance(ms: number) {
        now += ms;
        for (const x of q.filter((y) => y.at <= now)) {
          q.splice(q.indexOf(x), 1);
          x.f();
        }
      },
    };
  }

  function setupB() {
    const api = scriptedRange();
    const t = timers();
    const store: RangeStore = createRangeStore({
      api,
      scheduler: createScheduler(),
      now: () => 1_000_000,
      timers: t,
    });
    store.observeScope('demo', A1, 1_000_000);
    return { api, t, store };
  }
  const SIX = { fromMs: 100 * B, toMs: 100 * B + 6 * H, line: true };

  it('ranks never regress', async () => {
    const { api, store } = setupB();
    api.auto = (c) => ({ series: [fn({ a: '1' }, () => (c.req.stepMs === STEP ? 1 : 9))], scope: A1 });
    const v = view(W1);
    await store.load('o', v);
    const a = store.peek(v);
    expect(a?.rank).toBe(1);
    // A late coarse response of the same family lands.
    const coarse = view({ ...W1, widthPx: 300 });
    await store.load('o2', coarse);
    const b = store.peek(v);
    expect(b?.rank).toBe(1);
    expect(b?.held.series).toBe(a?.held.series);
  });

  it('coarse then fine after 120 ms', async () => {
    const { api, t, store } = setupB();
    const v = view(SIX);
    store.retain('o', v);
    void store.load('o', v).catch(() => undefined);
    await drain();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.req.stepMs).toBe(60_000);
    expect(api.calls[0]?.req.priority).toBe('high');
    t.advance(119);
    await drain();
    expect(api.calls).toHaveLength(1);
    t.advance(1);
    await drain();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.req.stepMs).toBe(STEP);
    expect(api.calls[1]?.req.priority).toBe('auto');
    api.calls[0]?.respond({ series: [fn({ a: '1' }, () => 1)], scope: A1 });
    await drain();
    expect(store.peekFilled(v)?.rank).toBe(0);
  });

  it('debounce cancels', async () => {
    const { api, t, store } = setupB();
    const v = view(SIX);
    store.retain('o', v);
    void store.load('o', v).catch(() => undefined);
    await drain();
    t.advance(100);
    store.retain('o', view({ fromMs: 500 * B, toMs: 500 * B + 6 * H, line: true }));
    expect(api.calls[0]?.signal?.aborted).toBe(true);
    t.advance(100);
    await drain();
    expect(
      api.calls.filter((c) => c.req.stepMs === STEP && c.req.fromMs < 200 * B),
    ).toHaveLength(0);
  });

  it('ladder after flanks, cancelled on move', async () => {
    const { api, store } = setupB();
    api.auto = (c) =>
      c.req.stepMs === 30_000 ? null : { series: [fn({ a: '1' }, () => 1)], scope: A1 };
    const v = view({ ...W1, line: true });
    store.retain('o', v);
    await store.load('o', v);
    await drain(8);
    const ladder = api.calls.filter((c) => c.req.stepMs === 30_000);
    expect(ladder).toHaveLength(1);
    expect(ladder[0]?.req.priority).toBe('low');
    store.retain('o', view({ fromMs: 600 * B, toMs: 600 * B + H, line: true }));
    expect(ladder[0]?.signal?.aborted).toBe(true);
  });
});
