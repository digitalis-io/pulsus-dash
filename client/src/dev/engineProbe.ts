/**
 * `__dashProbe` (plan #68 C2a1 §3.4; T03-024): the engine's test probe, in fault builds only
 * (`VITE_ENGINE_FAULTS=1`) and only on a page opened with `?probe=1` (`engine/index.ts`). A
 * release build has neither this module nor the global (`ci:probe-absent`). `e2e:shim-fuzz` drives
 * it in the probe build, whose engine also logs the records it decodes (`inputLog`).
 *
 * | Member | What |
 * |---|---|
 * | `frame(o)` | a probe frame on a canvas at (0, 0): spec, data, window and size; resolves with its number (0, 1, … in call order) at its first `a11y`. Calls before the frame exists wait in order |
 * | `call(n, m, arg)` | `setSpec`, `setData` (probe series), `setTimeWindow` or `resize` (`[w, h, dpr]`) |
 * | `settle(n)` | resolves when nothing is held or unpublished, the worker applied every published record and, at a non-zero size, presented the last one (`WasmFrame.settled`) |
 * | `last(n)`, `drawn(n)` | the last `a11y` summary; the `drawn` events (the last 100) |
 * | `idle()`, `counters()`, `stats()` | the worker's idle word; head and tail (`>>> 0`); coalesced, `INPUT_OVERFLOW`, bytes published |
 * | `inputLog()`, `producedLog()` | the records the worker decoded (probe build only) and the ones the adapter published |
 * | `wheel(n, x, y, init)`, `pointer(n, type, x, y, o)` | a wheel (returns `defaultPrevented`) or a pointer or mouse event on the frame's canvas at canvas px, built as `test/engineHarness.ts` builds them (plan #68 C2a2 §3.4) |
 * | `commits(n)`, `brushes(n)` | the frame's `commit` and `brush` events |
 * | `fresh(o)` | a new frame's first summary; the frame is then disposed and its canvas removed |
 * | `id(n)`, `stats().enqueued` | the frame's engine id (its records' `frame`); Camera records enqueued by probe frames |
 *
 * Probe frames are `ControlledFrame`s: the camera controller runs on them as on the page's engine
 * frames (ADR-0030), so the calls' `setTimeWindow` goes through it.
 */
import type {
  BrushEvent,
  CommitEvent,
  DrawnEvent,
  FrameData,
  FrameSummary,
  TimeWindow,
  VisSpec,
} from '../engine/api';
import { ControlledFrame } from '../engine/controlled';
import type { Backend, EngineProbe, ProbeHost } from '../engine/wasm/engine';
import { WasmFrame } from '../engine/wasm/frame';
import type { InputRec } from '../engine/wasm/ring';

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
}

export type ProbeCall = 'setSpec' | 'setData' | 'setTimeWindow' | 'resize';

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
  call(n: number, m: ProbeCall, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  drawn(n: number): DrawnEvent[];
  idle(): boolean;
  inputLog(): Promise<InputRec[]>;
  producedLog(): InputRec[];
  stats(): { coalesced: number; overflow: number; publishedBytes: number; enqueued: number };
  /** The engine's id of probe frame `n` (the ring records' `frame`); 0 before it exists. */
  id(n: number): number;
  counters(): { head: number; tail: number };
  wheel(n: number, x: number, y: number, init: ProbeWheel): boolean;
  pointer(n: number, type: string, x: number, y: number, o?: ProbePointer): void;
  commits(n: number): CommitEvent[];
  brushes(n: number): BrushEvent[];
  fresh(o: ProbeFrame): Promise<FrameSummary>;
}

interface Entry {
  /** The controlled frame the calls and DOM events drive, and its engine frame. */
  frame: ControlledFrame | null;
  inner: WasmFrame | null;
  canvas: HTMLCanvasElement | null;
  readonly queue: [ProbeCall, unknown][];
  last: FrameSummary | null;
  readonly drawn: DrawnEvent[];
  readonly commits: CommitEvent[];
  readonly brushes: BrushEvent[];
}

const SETTLE_POLL_MS = 5;
const SETTLE_TIMEOUT_MS = 60_000;
const KEEP_DRAWN = 100;

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

function apply(f: ControlledFrame, m: ProbeCall, arg: unknown): void {
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
  }
}

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
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${String(w)}px;height:${String(h)}px;z-index:2147483647`;
    document.body.append(canvas);
    const init = { timeZone: 'UTC', keyTarget: null, id };
    const inner = b.createFrame(canvas.transferControlToOffscreen(), init, (reason) => {
      console.warn(`${id} failed: ${reason}`);
    });
    if (!(inner instanceof WasmFrame)) throw new Error('not an engine frame');
    // Every Camera the controller sends is one ring record (bench:shim-input-cost).
    const setCamera = inner.setCamera.bind(inner);
    inner.setCamera = (c) => {
      enqueued += 1;
      setCamera(c);
    };
    const frame = new ControlledFrame(canvas, init, inner);
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
    });
    frame.on('commit', (c) => e.commits.push(c));
    frame.on('brush', (x) => e.brushes.push(x));
    frame.setSpec(f.spec);
    frame.setData(data(f.series));
    frame.setTimeWindow(f.w);
    frame.resize(w, h, f.dpr ?? 1);
  };
  const blank = (): Entry => ({
    frame: null,
    inner: null,
    canvas: null,
    queue: [],
    last: null,
    drawn: [],
    commits: [],
    brushes: [],
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
      if (e.frame === null) e.queue.push([m, arg]);
      else apply(e.frame, m, arg);
    },
    settle(n) {
      const e = entry(n);
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
        ctrlKey: init.ctrlKey ?? false,
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
    commits: (n) => [...entry(n).commits],
    brushes: (n) => [...entry(n).brushes],
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
