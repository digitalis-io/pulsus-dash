/**
 * The bounded-draw probe (plan #64 Part B §5): draws one line layer with extreme thresholds on a
 * recording context and prints `{ valueAxis, dashed }` as JSON. `thresholdBounds.test.ts` runs it
 * in a child process with a hard timeout, so a draw that never finishes (#97) fails the test
 * instead of hanging the run. Cases: `max` (±1e15) and `tiny` (1e-9 over zero data).
 *
 *   node scripts/threshold-draw-probe.ts max|tiny
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_ROOT, registerClientHooks } from './engine-fixtures.ts';

interface Probe {
  readonly values: readonly number[];
  readonly thresholds: readonly { value: number; state: string; label: string }[];
}

const CASES: Readonly<Record<string, Probe>> = {
  max: {
    values: [0, 10, 20, 30],
    thresholds: [
      { value: -1e15, state: 'watch', label: '' },
      { value: 1e15, state: 'failing', label: '' },
    ],
  },
  tiny: { values: [0, 0, 0, 0], thresholds: [{ value: 1e-9, state: 'watch', label: '' }] },
};

interface Op {
  readonly op: string;
  readonly args: readonly unknown[];
}

async function main(name: string | undefined): Promise<number> {
  const c = name === undefined ? undefined : CASES[name];
  if (c === undefined) {
    console.error('usage: node scripts/threshold-draw-probe.ts max|tiny');
    return 2;
  }
  registerClientHooks();
  const mod = async (p: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(join(CLIENT_ROOT, 'src', p)).href)) as Record<string, unknown>;
  const { drawLayer } = (await mod('engine/canvas2d/draw.ts')) as {
    drawLayer: (i: Record<string, unknown>) => { summary: { valueAxis: unknown } };
  };
  const { themeColours } = (await mod('engine/canvas2d/palette.ts')) as {
    themeColours: (t: string) => unknown;
  };
  const { recordingContext } = (await mod('test/recordingContext.ts')) as {
    recordingContext: () => { ops: Op[] };
  };
  const ctx = recordingContext();
  const ts = c.values.map((_, i) => i * 1_000);
  const { summary } = drawLayer({
    ctx,
    spec: { kind: 'line', title: '', unit: { kind: 'none' }, thresholds: c.thresholds },
    data: {
      kind: 'series',
      series: [
        {
          key: '0000000000000001',
          labels: {},
          timestamps: Float64Array.from(ts),
          values: Float64Array.from(c.values),
        },
      ],
    },
    window: { fromMs: 0, toMs: 3_000 },
    cssW: 800,
    cssH: 240,
    timeZone: 'UTC',
    colours: themeColours('dark'),
    valueRange: null,
    band: null,
    minBand: 0,
  });
  const dashed = ctx.ops.filter(
    (o) => o.op === 'setLineDash' && Array.isArray(o.args[0]) && o.args[0].length > 0,
  ).length;
  console.log(JSON.stringify({ valueAxis: summary.valueAxis, dashed }));
  return 0;
}

process.exitCode = await main(process.argv[2]);
