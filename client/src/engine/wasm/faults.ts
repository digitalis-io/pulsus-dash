/**
 * Test faults of the fault build (plan #68 C1 §4.3; `VITE_ENGINE_FAULTS=1` only). This module is
 * imported only under `if (import.meta.env.VITE_ENGINE_FAULTS === '1')` in `boot.ts` and
 * `render.worker.ts`, so a release build drops it; `ci:probe-absent` scans release builds for its
 * sentinel. Faults act on the first engine frame created (the gallery's `line-1`):
 *
 * - `surface`: it reports `failed{surface}` instead of drawing;
 * - `trap`: the render worker throws after its first `drawn` (the first boot only);
 * - `trap2`: the render worker throws after every `drawn`;
 * - `gap`: ten samples of its first series become NaN.
 */
import type { Fault, MainToRender, SeriesMessage } from './protocol';

const SENTINEL = '__pulsus_engine_fault__';
const FAULTS: readonly Fault[] = ['surface', 'trap', 'trap2', 'gap'];

/** The page's fault (`?fault=`), for the boot of the render worker. */
export function pageFault(search: string): Fault | undefined {
  const f = new URLSearchParams(search).get('fault');
  const fault = FAULTS.find((x) => x === f);
  if (fault !== undefined) console.warn(SENTINEL, fault);
  return fault;
}

/** The fault for a boot: `trap` only on the first. */
export function bootFault(fault: Fault | undefined, restart: boolean): Fault | undefined {
  return fault === 'trap' && restart ? undefined : fault;
}

/** The render worker's side of `fault`. */
export class WorkerFaults {
  private first: number | null = null;
  private trapped = false;

  constructor(private readonly fault: Fault) {
    console.warn(SENTINEL, fault);
  }

  /** True when `create` must fail instead (the first frame, `surface`). */
  failCreate(m: Extract<MainToRender, { t: 'create' }>): boolean {
    this.first ??= m.id;
    return this.fault === 'surface' && m.id === this.first;
  }

  /** The series as drawn (`gap`: ten samples of the first frame's first series become NaN). */
  data(id: number, series: readonly SeriesMessage[]): readonly SeriesMessage[] {
    const s0 = series[0];
    if (this.fault !== 'gap' || id !== this.first || s0 === undefined) return series;
    const v = Float64Array.from(s0.v);
    const at = Math.floor(v.length / 2);
    v.fill(NaN, at, Math.min(v.length, at + 10));
    return [{ ...s0, v }, ...series.slice(1)];
  }

  /** After an events batch: `trap` throws once after a `drawn`, `trap2` after every one. */
  afterEvents(json: string): void {
    if (!json.includes('"t":"drawn"')) return;
    if (this.fault === 'trap2' || (this.fault === 'trap' && !this.trapped)) {
      this.trapped = true;
      throw new Error(`${SENTINEL} ${this.fault}`);
    }
  }
}
