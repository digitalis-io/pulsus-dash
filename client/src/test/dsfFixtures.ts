/**
 * The DSF fixtures of plan #68 D2 §5 for the tests: the route fixtures (`wire/fixtures/route/`,
 * D1's real handler) and the engine's decoded message of each (`engine/fixtures/range-decoded/`,
 * every f64 as its 16-digit hex bits).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DecodedRange, WireCoverage, WireErrorRow } from '../api/rangeDecoder';

/** The repository root (vitest runs in `client/`). */
const ROOT = join(process.cwd(), '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** `Deps.Now` of the route fixtures (D1's clock, 2026-11-19T13:00Z). */
export const NOW_MS = 1_795_093_200_000;

/** A route fixture's JSON text (`<case>.json`, `err-<class>.json`). */
export function routeJson(name: string): string {
  return read('wire', 'fixtures', 'route', `${name}.json`);
}

/** A 16-digit hex bit pattern as its f64. */
export function f64(hex: string): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt(`0x${hex}`));
  return dv.getFloat64(0);
}

interface DecodedFixture {
  t: string;
  head: DecodedRange['head'];
  ts: string[];
  vs: string[][];
  /** Per series: the absent slots' indices, or null (#304 §A.3). */
  absent?: (number[] | null)[];
}

export interface FailedFixture {
  t: string;
  kind: string;
  row: WireErrorRow;
  coverage: WireCoverage | null;
  planned: string | null;
  message: string;
}

/** The fixture's `decoded` message as the worker posts it (chunk 1 of epoch 1 unless given). */
export function decodedMessage(name: string, chunk = 1, epoch = 1): DecodedRange {
  const m = JSON.parse(
    read('engine', 'fixtures', 'range-decoded', `${name}.json`),
  ) as DecodedFixture;
  if (m.t !== 'decoded') throw new Error(`${name} is not a decoded message`);
  return {
    chunk,
    epoch,
    head: m.head,
    ts: Float64Array.from(m.ts, f64),
    vs: m.vs.map((v) => Float64Array.from(v, f64)),
    ...(m.absent === undefined
      ? {}
      : {
          absent: m.absent.map((ix) => {
            if (ix === null) return null;
            const a = new Uint8Array(m.ts.length);
            for (const i of ix) a[i] = 1;
            return a;
          }),
        }),
  };
}

/** The fixture's `decode-failed` message. */
export function failedMessage(name: string): FailedFixture {
  const m = JSON.parse(
    read('engine', 'fixtures', 'range-decoded', `${name}.json`),
  ) as FailedFixture;
  if (m.t !== 'decode-failed') throw new Error(`${name} is not a decode-failed message`);
  return m;
}
