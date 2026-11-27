/**
 * `__dashProbe` (plan #68 C2a1 §3.4; T03-024): the engine's test probe, in fault builds only
 * (`VITE_ENGINE_FAULTS=1`) and only on a page opened with `?probe=1` (`engine/index.ts`). A
 * release build has neither this module nor the global (`ci:probe-absent`). `e2e:shim-fuzz` drives
 * it in the probe build, whose engine also logs the records it decodes (`inputLog`).
 *
 * | Member | What |
 * |---|---|
 * | `frame(o)` | a probe frame on a canvas at (0, 0): spec, data, window and size; resolves with its number (0, 1, … in call order) at its first `a11y`. Calls before the frame exists wait in order |
 * | `call(n, m, arg)` | `setSpec`, `setData` (probe series), `setTimeWindow`, `resize` (`[w, h, dpr]`), `setEvents` (event markers, plan #68 C2c1) or `setSelection` (a `FrameSelection` or `null`, plan #68 C2c2) |
 * | `frame2d(o)` | the same inputs on a Canvas 2D frame (`Canvas2DEngine`, plan #68 C2c2 S10), its number in the same list; `settle` waits two animation frames for it |
 * | `settle(n)` | resolves when nothing is held or unpublished, the worker applied every published record and, at a non-zero size, presented the last one (`WasmFrame.settled`) |
 * | `last(n)`, `drawn(n)` | the last `a11y` summary; the `drawn` events (the last 100) |
 * | `idle()`, `counters()`, `stats()` | the worker's idle word; head and tail (`>>> 0`); coalesced, `INPUT_OVERFLOW`, bytes published |
 * | `inputLog()`, `producedLog()` | the records the worker decoded (probe build only) and the ones the adapter published |
 * | `wheel(n, x, y, init)`, `pointer(n, type, x, y, o)` | a wheel (returns `defaultPrevented`) or a pointer or mouse event on the frame's canvas at canvas px, built as `test/engineHarness.ts` builds them (plan #68 C2a2 §3.4) |
 * | `commits(n)`, `brushes(n)` | the frame's `commit` and `brush` events |
 * | `fresh(o)` | a new frame's first summary; the frame is then disposed and its canvas removed |
 * | `holdTimers(on)` | holds the probe frames' controller timers (none fires; each restarts its full delay on release), so a screenshot does not end a gesture |
 * | `id(n)`, `stats().enqueued` | the frame's engine id (its records' `frame`); Camera records enqueued by probe frames |
 * | `hovers(n)`, `selects(n)` | the frame's `hover` and `select` events (plan #68 C2b §3.4) |
 * | `key(n, key)` | a `keydown` on the frame's canvas, its own key target (`tabindex=0`); returns `defaultPrevented` |
 * | `flush(n)` | `ControlledFrame.flush()`: the batched Camera and Overlay go out now |
 * | `freeze(n, seq)`, `frozen(n)`, `unfreeze(n)` | the probe build: after its first completed presentation with seq ≥ `seq` the worker presents nothing for the frame; `frozen` resolves with that presentation's `drawn` and seq |
 * | `renew()` | the probe build: every frame's renderer and surface made again, the frames redrawn (plan #68 C2c2 S11, the same-tier restore after a device loss) |
 * | `stats().bad`, `stats().selects` | `INPUT_BAD`; Select records the ring took |
 * | `stats().batches`, `stats().batchesInFlightMax` | ST (plan #68 C2d2): batches posted and the most in flight end to end; `overflow` is then the batch ring's dropped Selects and `bad` the worker's last reported `INPUT_BAD` |
 * | `synth(n, o, timeoutMs?)` | the probe build (plan #68 C2d1 §3.2): F1c of `o.series` × `o.points` built in the worker as the frame's data (`Frames::set_chunk`); resolves on the worker's acknowledgement `{ok, bytes}`, or `ok: false` with `reason` `alloc` (the worker's allocation failed), `fatal`, `restart` or `timeout` (120 s by default) |
 * | `synthFault(f)` | the next `synth` only: `alloc` answers `ok: false, reason: 'alloc'` at once, `silent` withholds the answer (it times out), `fatal` answers `reason: 'fatal'`; `null` clears it |
 * | `chunk(n)` | the probe build: `{series, points, bytes}` of the frame's current chunk (points: series 0's samples), or null |
 * | `policyWorker(url)` | plan #68 C2d2: a module worker from `url` through the real `pulsus-engine` policy; `started` or the error's name (an unrelated URL: `TypeError`) |
 * | `failed(n)`, `trap()` | the frame's `onFail` reasons (`restart`, `trap`, `surface`, …); the probe build: the render worker traps for real (plan #68 C2d1) |
 * | `decodes()`, `chunks()`, `decoder(on)` | plan #68 D2: the DSF decodes (begun, done, failed, aborted, retried as JSON, body bytes the pool consumed, by-reference `setData`); the worker's chunk table (count, bytes, unheld bytes, decodes in flight); the range decoder slot off or back on |
 *
 * A frame's canvas is at (0, `o.top ?? 0`) CSS px.
 *
 * Probe frames are `ControlledFrame`s: the camera controller runs on them as on the page's engine
 * frames (ADR-0030), so the calls' `setTimeWindow` goes through it.
 */
import type {
  BrushEvent,
  CommitEvent,
  DrawnEvent,
  ChartFrame,
  EventMarker,
  FrameData,
  FrameSelection,
  FrameSummary,
  HoverEvent,
  SelectEvent,
  TimeWindow,
  VisSpec,
} from '../engine/api';
import { Canvas2DEngine } from '../engine/canvas2d/Canvas2DEngine';
import { ControlledFrame } from '../engine/controlled';
import type {
  Backend,
  ChunkInfo,
  ChunkStats,
  EngineProbe,
  ProbeHost,
  SynthAck,
} from '../engine/wasm/engine';
import { WasmFrame } from '../engine/wasm/frame';
import type { InputRec } from '../engine/wasm/ring';
import { scriptUrl } from '../engine/wasm/workers';
import { refStats } from '../engine/wasm/chunkRefs';
import { decodeStats, rangeDecoder, setRangeDecoder, type RangeDecoder } from '../api/rangeDecoder';

export interface ProbeSeries {
  readonly key: string;
  readonly t: readonly number[];
  readonly v: readonly number[];
}

export interface ProbeFrame {
  readonly spec: VisSpec;
  readonly series: readonly ProbeSeries[];
  readonly w: TimeWindow;
  readonly size: readonly [number, number];
  readonly dpr?: number;
  /** The canvas's top, CSS px (default 0). */
  readonly top?: number;
}

export type ProbeCall =
  'setSpec' | 'setData' | 'setTimeWindow' | 'resize' | 'setEvents' | 'setSelection';

/** A wheel as `test/engineHarness.ts` builds it. */
export interface ProbeWheel {
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaMode?: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

/** A pointer or mouse event as `test/engineHarness.ts` builds it. */
export interface ProbePointer {
  readonly button?: number;
  readonly buttons?: number;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly pointerType?: string;
}

export interface DashProbe {
  frame(o: ProbeFrame): Promise<number>;
  /** The same inputs on a Canvas 2D frame (plan #68 C2c2 S10): its number at its first `a11y`. */
  frame2d(o: ProbeFrame): Promise<number>;
  call(n: number, m: ProbeCall, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  drawn(n: number): DrawnEvent[];
  idle(): boolean;
  inputLog(): Promise<InputRec[]>;
  producedLog(): InputRec[];
  stats(): {
    coalesced: number;
    overflow: number;
    publishedBytes: number;
    enqueued: number;
    bad: number;
    selects: number;
    /** ST (plan #68 C2d2): batches posted, and the most in flight end to end (0 in MT). */
    batches: number;
    batchesInFlightMax: number;
  };
  /** The engine's id of probe frame `n` (the ring records' `frame`); 0 before it exists. */
  id(n: number): number;
  counters(): { head: number; tail: number };
  wheel(n: number, x: number, y: number, init: ProbeWheel): boolean;
  pointer(n: number, type: string, x: number, y: number, o?: ProbePointer): void;
  commits(n: number): CommitEvent[];
  brushes(n: number): BrushEvent[];
  fresh(o: ProbeFrame): Promise<FrameSummary>;
  /**
   * Holds the probe frames' controller timers (the wheel-idle commit): while held none fires, and
   * on release each restarts its full delay. A screenshot inside a gesture does not end it.
   */
  holdTimers(on: boolean): void;
  /** The frame's `hover` events (plan #68 C2b §3.4). */
  hovers(n: number): (HoverEvent | null)[];
  /** The frame's `select` events. */
  selects(n: number): SelectEvent[];
  /** A `keydown` of `key` on the frame's canvas (its key target); whether it was prevented. */
  key(n: number, key: string): boolean;
  /** The batched Camera and Overlay of the frame go out now (`ControlledFrame.flush`). */
  flush(n: number): void;
  /** The probe build: hold the frame after its first completed presentation with seq ≥ `seq`. */
  freeze(n: number, seq: number): void;
  /** That presentation's `drawn` and seq. */
  frozen(n: number): Promise<DrawnEvent & { seq: number }>;
  unfreeze(n: number): void;
  /** The probe build (plan #68 C2c2 S11): every frame's renderer made again, as after a loss. */
  renew(): void;
  /**
   * The probe build (plan #68 C2d1 §3.2): F1c (`series` × `points` on a grid, key hash = series
   * index) as the frame's data; `ok: false` on a failed allocation, a timeout, a fatal or a restart.
   */
  synth(
    n: number,
    o: { readonly series: number; readonly points: number },
    timeoutMs?: number,
  ): Promise<SynthAck>;
  /** The next `synth`'s simulated outcome (plan #68 C2d1 `synth outcomes`); null clears it. */
  synthFault(f: SynthFault | null): void;
  /** The probe build: the frame's current chunk, or null. */
  chunk(n: number): Promise<ChunkInfo | null>;
  /** The frame's `onFail` reasons, in order. */
  failed(n: number): string[];
  /** The probe build: the render worker traps (a real failure). */
  trap(): void;
  /**
   * Plan #68 C2d2 (ADR-0033): starts a module worker from `url` through the page's real
   * `pulsus-engine` policy (`workers.ts` `scriptUrl`); `started`, or the error's name.
   */
  policyWorker(url: string): string;
  /**
   * Plan #68 D2: the DSF decodes of the page: begun, done, failed, aborted, retried as JSON, and
   * the `setData` calls that went by reference.
   */
  decodes(): {
    begun: number;
    done: number;
    failed: number;
    aborted: number;
    retried: number;
    credited: number;
    byRef: number;
  };
  /** Plan #68 D2: the worker's chunk table and decodes in flight; null without an MT engine. */
  chunks(): Promise<ChunkStats | null>;
  /** Plan #68 D2: the range decoder slot off (`false`: every range query JSON) or back on. */
  decoder(on: boolean): void;
}

export type SynthFault = 'alloc' | 'silent' | 'fatal';

interface Entry {
  /** The controlled frame the calls and DOM events drive, and its engine frame. */
  frame: ControlledFrame | null;
  /** A Canvas 2D frame (`frame2d`) instead. */
  chart: ChartFrame | null;
  inner: WasmFrame | null;
  canvas: HTMLCanvasElement | null;
  readonly queue: [ProbeCall, unknown][];
  last: FrameSummary | null;
  readonly drawn: DrawnEvent[];
  readonly commits: CommitEvent[];
  readonly brushes: BrushEvent[];
  readonly hovers: (HoverEvent | null)[];
  readonly selects: SelectEvent[];
  /** `drawn` events with their presentation seq (`frozen`). */
  readonly seqs: (DrawnEvent & { seq: number })[];
  /** The seq `freeze` waits for. */
  freezeAt: number | null;
  /** The frame's `onFail` reasons. */
  readonly failed: string[];
}

const SETTLE_POLL_MS = 5;
const FROZEN_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 60_000;
const KEEP_DRAWN = 100;
const SYNTH_TIMEOUT_MS = 120_000;

function data(series: readonly ProbeSeries[]): FrameData {
  return {
    kind: 'series',
    series: series.map((s) => ({
      key: s.key,
      labels: {},
      timestamps: Float64Array.from(s.t),
      values: Float64Array.from(s.v),
    })),
  };
}

function apply(f: ChartFrame, m: ProbeCall, arg: unknown): void {
  switch (m) {
    case 'setSpec':
      f.setSpec(arg as VisSpec);
      return;
    case 'setData':
      f.setData(data(arg as readonly ProbeSeries[]));
      return;
    case 'setTimeWindow':
      f.setTimeWindow(arg as TimeWindow);
      return;
    case 'resize': {
      const [w, h, dpr] = arg as readonly [number, number, number];
      f.resize(w, h, dpr);
      return;
    }
    case 'setEvents':
      f.setEvents(arg as readonly EventMarker[]);
      return;
    case 'setSelection':
      f.setSelection(arg as FrameSelection | null);
      return;
  }
}

/** Two animation frames: a Canvas 2D frame has drawn what it was given. */
const frames2 = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        r();
      });
    });
  });

export function createProbe(o: {
  readonly backend: () => Promise<Backend>;
  readonly host: () => ProbeHost | null;
}): DashProbe {
  const entries: Entry[] = [];
  const entry = (n: number): Entry => {
    const e = entries[n];
    if (e === undefined) throw new Error(`no probe frame ${String(n)}`);
    return e;
  };
  let enqueued = 0;
  /** The next `synth`'s simulated outcome (plan #68 C2d1). */
  let synthFault: SynthFault | null = null;
  /** `decoder(false)`'s saved slot (plan #68 D2). */
  let saved: RangeDecoder | null = null;
  // The probe frames' controller timers, holdable (`holdTimers`).
  let held = false;
  let nextTimer = 1;
  const timers = new Map<
    number,
    { cb: () => void; ms: number; t: ReturnType<typeof setTimeout> | null }
  >();
  const arm = (id: number): void => {
    const x = timers.get(id);
    if (x === undefined) return;
    x.t = setTimeout(() => {
      timers.delete(id);
      x.cb();
    }, x.ms);
  };
  const deps = {
    setTimer: (cb: () => void, ms: number): number => {
      const id = nextTimer++;
      timers.set(id, { cb, ms, t: null });
      if (!held) arm(id);
      return id;
    },
    clearTimer: (id: number): void => {
      const x = timers.get(id);
      if (x?.t !== null && x?.t !== undefined) clearTimeout(x.t);
      timers.delete(id);
    },
  };
  /**
   * A frame on a canvas at (0, 0), above the page: its spec, data, window and size, then
   * `onA11y` at each summary.
   */
  const make = (
    b: Backend,
    f: ProbeFrame,
    e: Entry,
    id: string,
    onA11y: (s: FrameSummary) => void,
  ): void => {
    const [w, h] = f.size;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `position:fixed;left:0;top:${String(f.top ?? 0)}px;width:${String(w)}px;height:${String(h)}px;z-index:2147483647`;
    // Its own key target (plan #68 C2b §3.4): `key(n, …)` drives the keyboard crosshair.
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const init = { timeZone: 'UTC', keyTarget: canvas, id };
    const inner = b.createFrame(canvas.transferControlToOffscreen(), init, (reason) => {
      e.failed.push(reason);
      console.warn(`${id} failed: ${reason}`);
    });
    if (!(inner instanceof WasmFrame)) throw new Error('not an engine frame');
    // Every Camera the controller sends is one ring record (bench:shim-input-cost).
    const setCamera = inner.setCamera.bind(inner);
    inner.setCamera = (c) => {
      enqueued += 1;
      setCamera(c);
    };
    const frame = new ControlledFrame(canvas, init, inner, deps);
    e.frame = frame;
    e.inner = inner;
    e.canvas = canvas;
    frame.on('a11y', (s) => {
      e.last = s;
      onA11y(s);
    });
    frame.on('drawn', (d) => {
      e.drawn.push(d);
      if (e.drawn.length > KEEP_DRAWN) e.drawn.shift();
      e.seqs.push({ ...d, seq: inner.drawnSeqNow() });
      if (e.seqs.length > KEEP_DRAWN) e.seqs.shift();
    });
    frame.on('hover', (x) => e.hovers.push(x));
    frame.on('select', (x) => e.selects.push(x));
    frame.on('commit', (c) => e.commits.push(c));
    frame.on('brush', (x) => e.brushes.push(x));
    frame.setSpec(f.spec);
    frame.setData(data(f.series));
    frame.setTimeWindow(f.w);
    frame.resize(w, h, f.dpr ?? 1);
  };
  const blank = (): Entry => ({
    frame: null,
    chart: null,
    inner: null,
    canvas: null,
    queue: [],
    last: null,
    drawn: [],
    commits: [],
    brushes: [],
    hovers: [],
    selects: [],
    seqs: [],
    freezeAt: null,
    failed: [],
  });
  /** A point at canvas-relative CSS px `(x, y)`, as client px. */
  const client = (c: HTMLCanvasElement, x: number, y: number) => {
    const r = c.getBoundingClientRect();
    return { clientX: r.left + x, clientY: r.top + y };
  };
  return {
    frame(f) {
      const n = entries.length;
      const e = blank();
      entries.push(e);
      return o.backend().then(
        (b) =>
          new Promise<number>((resolve) => {
            make(b, f, e, `probe-${String(n)}`, () => {
              resolve(n);
            });
            const frame = e.frame;
            if (frame !== null) for (const [m, arg] of e.queue.splice(0)) apply(frame, m, arg);
          }),
      );
    },
    frame2d(f) {
      const n = entries.length;
      const e = blank();
      entries.push(e);
      const [w, h] = f.size;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `position:fixed;left:0;top:${String(f.top ?? 0)}px;width:${String(w)}px;height:${String(h)}px;z-index:2147483647`;
      document.body.append(canvas);
      const chart = new Canvas2DEngine().createFrame(canvas, {
        timeZone: 'UTC',
        keyTarget: canvas,
        id: `probe-2d-${String(n)}`,
      });
      e.chart = chart;
      e.canvas = canvas;
      chart.on('hover', (x) => e.hovers.push(x));
      chart.on('drawn', (d) => {
        e.drawn.push(d);
        if (e.drawn.length > KEEP_DRAWN) e.drawn.shift();
      });
      return new Promise<number>((resolve) => {
        chart.on('a11y', (s) => {
          const first = e.last === null;
          e.last = s;
          if (first) resolve(n);
        });
        chart.setSpec(f.spec);
        chart.setData(data(f.series));
        chart.setTimeWindow(f.w);
        chart.resize(w, h, f.dpr ?? 1);
      });
    },
    fresh(f) {
      const e = blank();
      return o.backend().then(
        (b) =>
          new Promise<FrameSummary>((resolve) => {
            make(b, f, e, 'probe-fresh', (s) => {
              e.frame?.dispose();
              e.canvas?.remove();
              resolve(s);
            });
          }),
      );
    },
    call(n, m, arg) {
      const e = entry(n);
      if (e.chart !== null) apply(e.chart, m, arg);
      else if (e.frame === null) e.queue.push([m, arg]);
      else apply(e.frame, m, arg);
    },
    settle(n) {
      const e = entry(n);
      if (e.chart !== null) return frames2();
      // The batched Camera and Overlay of this task go out first (plan #68 C2b §4.1).
      e.frame?.flush();
      const t0 = performance.now();
      return new Promise<void>((resolve, reject) => {
        const poll = (): void => {
          if (e.inner !== null && e.queue.length === 0 && e.inner.settled()) {
            resolve();
            return;
          }
          if (performance.now() - t0 > SETTLE_TIMEOUT_MS) {
            reject(new Error(`probe frame ${String(n)} did not settle`));
            return;
          }
          setTimeout(poll, SETTLE_POLL_MS);
        };
        poll();
      });
    },
    last: (n) => entry(n).last,
    drawn: (n) => [...entry(n).drawn],
    idle: () => o.host()?.idle() ?? false,
    inputLog: () => o.host()?.inputLog() ?? Promise.resolve([]),
    producedLog: () => [...(o.host()?.ring.produced ?? [])],
    stats() {
      const h = o.host();
      return {
        coalesced: h?.ring.stats.coalesced ?? 0,
        overflow: h?.overflow() ?? 0,
        publishedBytes: h?.ring.stats.publishedBytes ?? 0,
        enqueued,
        bad: h?.bad() ?? 0,
        selects: h?.ring.stats.selects ?? 0,
        batches: h?.batches().batches ?? 0,
        batchesInFlightMax: h?.batches().inFlightMax ?? 0,
      };
    },
    counters: () => o.host()?.counters() ?? { head: 0, tail: 0 },
    id: (n) => entry(n).inner?.id ?? 0,
    wheel(n, x, y, init) {
      const c = entry(n).canvas;
      if (c === null) return false;
      // As `test/engineHarness.ts` `wheel`.
      const ev = new WheelEvent('wheel', {
        ...client(c, x, y),
        deltaX: init.deltaX ?? 0,
        deltaY: init.deltaY ?? 0,
        deltaMode: init.deltaMode ?? 0,
        shiftKey: init.shiftKey ?? false,
        // A time chart zooms only with Ctrl/⌘ held: Ctrl unless set (or ⌘ is).
        ctrlKey: init.ctrlKey ?? init.metaKey !== true,
        metaKey: init.metaKey ?? false,
        bubbles: true,
        cancelable: true,
      });
      c.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    pointer(n, type, x, y, p = {}) {
      const c = entry(n).canvas;
      if (c === null) return;
      // As `test/engineHarness.ts` `pointer`.
      const init = {
        ...client(c, x, y),
        button: p.button ?? 0,
        buttons: p.buttons ?? 0,
        altKey: p.altKey ?? false,
        ctrlKey: p.ctrlKey ?? false,
        metaKey: p.metaKey ?? false,
        pointerType: p.pointerType ?? 'mouse',
        pointerId: 1,
        bubbles: true,
        cancelable: true,
      };
      c.dispatchEvent(
        type === 'dblclick' || type === 'contextmenu'
          ? new MouseEvent(type, init)
          : new PointerEvent(type, init),
      );
    },
    holdTimers(on) {
      held = on;
      for (const [id, x] of timers) {
        if (on && x.t !== null) {
          clearTimeout(x.t);
          x.t = null;
        } else if (!on && x.t === null) {
          arm(id);
        }
      }
    },
    commits: (n) => [...entry(n).commits],
    brushes: (n) => [...entry(n).brushes],
    hovers: (n) => [...entry(n).hovers],
    selects: (n) => [...entry(n).selects],
    key(n, key) {
      const c = entry(n).canvas;
      if (c === null) return false;
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    flush(n) {
      entry(n).frame?.flush();
    },
    freeze(n, seq) {
      const e = entry(n);
      e.freezeAt = seq;
      const id = e.inner?.id;
      if (id !== undefined) o.host()?.freeze(id, seq);
    },
    frozen(n) {
      const e = entry(n);
      const t0 = performance.now();
      return new Promise((resolve, reject) => {
        const poll = (): void => {
          const at = e.freezeAt;
          const d = at === null ? undefined : e.seqs.find((x) => x.seq >= at);
          if (d !== undefined) {
            resolve(d);
            return;
          }
          if (performance.now() - t0 > FROZEN_TIMEOUT_MS) {
            reject(new Error(`probe frame ${String(n)}: no presentation of seq ${String(at)}`));
            return;
          }
          setTimeout(poll, SETTLE_POLL_MS);
        };
        poll();
      });
    },
    renew() {
      o.host()?.renew();
    },
    synth(n, s, timeoutMs = SYNTH_TIMEOUT_MS) {
      const id = entry(n).inner?.id;
      const h = o.host();
      // A simulated outcome, once (`synthFault`): the precedence the bench applies.
      const f = synthFault;
      synthFault = null;
      if (f === 'alloc') return Promise.resolve({ ok: false, bytes: 0, reason: 'alloc' });
      if (f === 'fatal') return Promise.resolve({ ok: false, bytes: 0, reason: 'fatal' });
      if (f === 'silent')
        return new Promise<SynthAck>((resolve) => {
          setTimeout(() => {
            resolve({ ok: false, bytes: 0, reason: 'timeout' });
          }, timeoutMs);
        });
      if (id === undefined || h === null)
        return Promise.resolve({ ok: false, bytes: 0, reason: 'timeout' });
      return new Promise<SynthAck>((resolve) => {
        const t = setTimeout(() => {
          resolve({ ok: false, bytes: 0, reason: 'timeout' });
        }, timeoutMs);
        void h.synth(id, s.series, s.points).then((a) => {
          clearTimeout(t);
          resolve(a);
        });
      });
    },
    synthFault(f) {
      synthFault = f;
    },
    failed: (n) => [...entry(n).failed],
    decodes() {
      return { ...decodeStats, byRef: refStats.byRef };
    },
    chunks() {
      const h = o.host();
      return h === null ? Promise.resolve(null) : h.chunks();
    },
    decoder(on) {
      if (!on) {
        saved ??= rangeDecoder();
        setRangeDecoder(null);
        return;
      }
      if (saved !== null) setRangeDecoder(saved);
      saved = null;
    },
    trap() {
      o.host()?.trap();
    },
    policyWorker(url) {
      try {
        // The probe's question is whether a worker starts; it is ended at once if one does.
        new Worker(scriptUrl(url), { type: 'module' }).terminate();
        return 'started';
      } catch (e) {
        return e instanceof Error ? e.name : String(e);
      }
    },
    chunk(n) {
      const id = entry(n).inner?.id;
      const h = o.host();
      if (id === undefined || h === null) return Promise.resolve(null);
      return h.chunk(id);
    },
    unfreeze(n) {
      const e = entry(n);
      e.freezeAt = null;
      const id = e.inner?.id;
      if (id !== undefined) o.host()?.unfreeze(id);
    },
  };
}

/**
 * Sets `__dashProbe` and returns the engine loader the routing engine uses, so the probe's frames
 * and the page's share one engine. `?ringStart=<u32>` starts the ring's counters there.
 */
export function installProbe(
  load: (probe: EngineProbe) => Promise<Backend>,
  search: string,
): () => Promise<Backend> {
  let host: ProbeHost | null = null;
  const start = new URLSearchParams(search).get('ringStart');
  const ringStart = start === null ? undefined : Number(start) >>> 0;
  let backend: Promise<Backend> | null = null;
  const get = (): Promise<Backend> =>
    (backend ??= load({
      ...(ringStart === undefined ? {} : { ringStart }),
      onHost: (h) => {
        host = h;
      },
    }));
  (globalThis as { __dashProbe?: DashProbe }).__dashProbe = createProbe({
    backend: get,
    host: () => host,
  });
  return get;
}
