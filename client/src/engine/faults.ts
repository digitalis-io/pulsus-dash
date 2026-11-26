/**
 * Test faults of the fault build (plan #68 C1 §4.3; `VITE_ENGINE_FAULTS=1` only). Three sites call
 * `installFaults('__pulsus_engine_fault__:<site>', fault)` inside `if
 * (import.meta.env.VITE_ENGINE_FAULTS === '1')`: `route.ts` (`route`), `wasm/boot.ts` (`boot`) and
 * `wasm/render.worker.ts` (`worker`). A release build drops the block and its literal;
 * `ci:probe-absent` fails a release tree with any sentinel and, with `--expect-faults`, a fault
 * tree without all three. Faults act on the first engine frame created (the gallery's `line-1`):
 *
 * | Fault | Site | Effect |
 * |---|---|---|
 * | `surface` | worker | the first line frame reports `failed{surface}` instead of drawing |
 * | `trap` | boot, worker | the render worker throws after its first `drawn` (first boot only) |
 * | `trap2` | worker | the render worker throws after every `drawn` |
 * | `gap` | worker | ten samples of the first frame's first series become NaN |
 * | `empty` | route | every value of every frame's series data becomes NaN |
 * | `noline` | worker | no line is drawn: the series are moved out of the window, so the value axis and guides stay |
 */
import type { FrameData } from './api';

export type Fault = 'surface' | 'trap' | 'trap2' | 'gap' | 'empty' | 'noline';

const FAULTS: readonly Fault[] = ['surface', 'trap', 'trap2', 'gap', 'empty', 'noline'];

/** `name` if it is a fault. */
export function asFault(name: string | null | undefined): Fault | undefined {
  return FAULTS.find((x) => x === name);
}

/** The `fault` URL parameter, if it names a fault. */
export function faultOf(search: string): Fault | undefined {
  return asFault(new URLSearchParams(search).get('fault'));
}

/** The series of a worker `data` message. */
export interface FaultSeries {
  readonly key: string;
  readonly names: readonly string[];
  readonly values: readonly string[];
  readonly t: Float64Array;
  readonly v: Float64Array;
}

export interface FaultSite {
  readonly fault: Fault | undefined;
  /** route: the data a frame passes on (`empty`). */
  data(d: FrameData): FrameData;
  /** boot: the fault of a boot (`trap` only on the first). */
  bootFault(restart: boolean): Fault | undefined;
  /** worker: true when this `create` fails instead (`surface`, the first frame). */
  failCreate(id: number): boolean;
  /** worker: the series a frame draws (`gap`, `noline`). */
  series(id: number, s: readonly FaultSeries[]): readonly FaultSeries[];
  /** worker: after an events batch (`trap`, `trap2`). */
  afterEvents(json: string): void;
}

/** One site's faults; `sentinel` names the site in the log and the build. */
export function installFaults(sentinel: string, fault: Fault | undefined): FaultSite {
  if (fault !== undefined) console.warn(sentinel, fault);
  let first: number | null = null;
  let trapped = false;
  return {
    fault,
    data(d) {
      if (fault !== 'empty' || d.kind !== 'series') return d;
      return {
        kind: 'series',
        series: d.series.map((s) => ({
          ...s,
          values: new Float64Array(s.values.length).fill(NaN),
        })),
      };
    },
    bootFault(restart) {
      return fault === 'trap' && restart ? undefined : fault;
    },
    failCreate(id) {
      first ??= id;
      return fault === 'surface' && id === first;
    },
    series(id, s) {
      if (fault === 'noline') {
        // A year past the window: the line is outside every column, the values unchanged.
        return s.map((x) => ({ ...x, t: x.t.map((t) => t + 365 * 86_400_000) }));
      }
      const s0 = s[0];
      if (fault !== 'gap' || id !== first || s0 === undefined) return s;
      const v = Float64Array.from(s0.v);
      const at = Math.floor(v.length / 2);
      v.fill(NaN, at, Math.min(v.length, at + 10));
      return [{ ...s0, v }, ...s.slice(1)];
    },
    afterEvents(json) {
      if (!json.includes('"t":"drawn"')) return;
      if (fault === 'trap2' || (fault === 'trap' && !trapped)) {
        trapped = true;
        throw new Error(`${sentinel} ${fault}`);
      }
    },
  };
}
