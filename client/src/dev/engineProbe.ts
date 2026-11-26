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
 */
import type { DrawnEvent, FrameData, FrameSummary, TimeWindow, VisSpec } from '../engine/api';
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

export interface DashProbe {
  frame(o: ProbeFrame): Promise<number>;
  call(n: number, m: ProbeCall, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  drawn(n: number): DrawnEvent[];
  idle(): boolean;
  inputLog(): Promise<InputRec[]>;
  producedLog(): InputRec[];
  stats(): { coalesced: number; overflow: number; publishedBytes: number };
  counters(): { head: number; tail: number };
}

interface Entry {
  frame: WasmFrame | null;
  readonly queue: [ProbeCall, unknown][];
  last: FrameSummary | null;
  readonly drawn: DrawnEvent[];
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

function apply(f: WasmFrame, m: ProbeCall, arg: unknown): void {
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
  return {
    frame(f) {
      const n = entries.length;
      const e: Entry = { frame: null, queue: [], last: null, drawn: [] };
      entries.push(e);
      return o.backend().then(
        (b) =>
          new Promise<number>((resolve) => {
            const [w, h] = f.size;
            const canvas = document.createElement('canvas');
            canvas.style.cssText = `position:fixed;left:0;top:0;width:${String(w)}px;height:${String(h)}px`;
            document.body.append(canvas);
            const frame = b.createFrame(
              canvas.transferControlToOffscreen(),
              { timeZone: 'UTC', keyTarget: null, id: `probe-${String(n)}` },
              (reason) => {
                console.warn(`probe frame ${String(n)} failed: ${reason}`);
              },
            );
            if (!(frame instanceof WasmFrame)) throw new Error('not an engine frame');
            e.frame = frame;
            frame.on('a11y', (s) => {
              e.last = s;
              resolve(n);
            });
            frame.on('drawn', (d) => {
              e.drawn.push(d);
              if (e.drawn.length > KEEP_DRAWN) e.drawn.shift();
            });
            frame.setSpec(f.spec);
            frame.setData(data(f.series));
            frame.setTimeWindow(f.w);
            frame.resize(w, h, f.dpr ?? 1);
            for (const [m, arg] of e.queue.splice(0)) apply(frame, m, arg);
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
          if (e.frame !== null && e.queue.length === 0 && e.frame.settled()) {
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
      };
    },
    counters: () => o.host()?.counters() ?? { head: 0, tail: 0 },
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
