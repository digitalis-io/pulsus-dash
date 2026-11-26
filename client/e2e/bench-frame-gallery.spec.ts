/**
 * `bench:frame-gallery` (plan #68 C2d1 §4.1, §4.3; T05 §4.3; PRF-001, PRF-002, VIZ-004; report
 * only): every gallery page the engine draws, on each leg — `wasm-webgl2` (`&mode=t2`, lavapipe),
 * `wasm-webgpu` (SwiftShader: `skipped: 'leg-unavailable'` while `engine-legs.json` makes the leg
 * report-only or the browser cannot render it) and `canvas2d` (`&engine=canvas2d`, the baseline on
 * the same host) — under `SCRIPT` (zoom in, pan, zoom out) and, as `<page>-hover`, `HOVER`. Each
 * case opens the gallery afresh. Its presented frames (`chart-present`) and draw times
 * (`chart-draw`) go to `test-results/bench/bench-frame-gallery.json`. Only the sanity checks fail
 * the run: ≥ 100 frames, the window moved by a script, a hover on ≥ 90 % of the hover steps, the
 * frame still on its leg; no budget does. Project `bench` (`make engine-bench`).
 */
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { summarise, type BenchLeg, type BenchResult } from '../scripts/lib/benchStats.ts';
import { drive, HOVER, readResults, report, reportGaps, SCRIPT } from './bench/frameBench.ts';
import { framesReady, liveCanvas, webgpuReportOnly } from './engine.ts';
import { frame, GALLERY_URL, open } from './helpers.ts';
import { SWIFTSHADER_ARGS } from '../playwright.engine.config.ts';

const GATE = 'bench:frame-gallery';

/** The engine's gallery pages (`golden-engine-line.spec.ts`), with their volume (`dev/gallery.ts`). */
const PAGES: readonly { id: string; series: number; points: number }[] = [
  { id: 'line-1', series: 1, points: 1_440 },
  { id: 'line-50', series: 50, points: 50 * 1_440 },
  { id: 'line-gaps', series: 3, points: 3 * 1_440 },
  { id: 'line-600', series: 600, points: 600 * 60 },
  { id: 'line-thresholds', series: 3, points: 3 * 1_440 },
  { id: 'line-extreme', series: 1, points: 1_440 },
  { id: 'line-events', series: 1, points: 1_440 },
];

const LEGS: readonly { leg: BenchLeg; query: string }[] = [
  { leg: 'wasm-webgl2', query: '&engine=wasm&mode=t2' },
  { leg: 'wasm-webgpu', query: '&engine=wasm' },
  { leg: 'canvas2d', query: '&engine=canvas2d' },
];

const MIN_FRAMES = 100;
const MIN_HOVER_SHARE = 0.9;

/** The frame's window as its last `a11y` reported it (the crosshair slider's range). */
async function windowOf(page: Page, id: string): Promise<[number, number]> {
  const s = frame(page, id).locator('[role="slider"]');
  return [
    Number(await s.getAttribute('aria-valuemin')),
    Number(await s.getAttribute('aria-valuemax')),
  ];
}

/** Counts the frame's hover changes (its crosshair's `aria-valuenow`) until `stop`. */
async function watchHovers(page: Page, id: string): Promise<() => Promise<number>> {
  await frame(page, id).evaluate((f) => {
    const s = f.querySelector('[role="slider"]');
    const w = window as unknown as { __benchHovers: number; __benchHoverObs?: MutationObserver };
    w.__benchHovers = 0;
    w.__benchHoverObs?.disconnect();
    const o = new MutationObserver((list) => {
      w.__benchHovers += list.length;
    });
    if (s !== null) o.observe(s, { attributes: true, attributeFilter: ['aria-valuenow'] });
    w.__benchHoverObs = o;
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __benchHovers: number; __benchHoverObs?: MutationObserver };
      w.__benchHoverObs?.disconnect();
      return w.__benchHovers;
    });
}

interface Run {
  result: BenchResult;
  hovers: number;
  moved: boolean;
  /** The frame's renderer and the engine status after the run. */
  engine: string | null;
  status: string | null;
}

async function runCase(
  browser: Browser,
  leg: (typeof LEGS)[number],
  p: (typeof PAGES)[number],
  hover: boolean,
): Promise<Run | 'leg-unavailable'> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await open(page, `${GALLERY_URL}${leg.query}`);
    await framesReady(page);
    const canvas = liveCanvas(page, p.id);
    if ((await canvas.getAttribute('data-engine')) !== leg.leg) return 'leg-unavailable';
    await canvas.scrollIntoViewIfNeeded();
    const frameId = await frame(page, p.id).getAttribute('data-frame-id');
    if (frameId === null) throw new Error(`${p.id}: no data-frame-id`);
    const before = await windowOf(page, p.id);
    const hovers = await watchHovers(page, p.id);
    const sel = `[data-gallery-id="${p.id}"] [data-chart-frame] canvas:not([data-retired])`;
    const d = await drive(page, sel, frameId, hover ? HOVER : SCRIPT);
    const n = await hovers();
    const after = await windowOf(page, p.id);
    const result = summarise(
      {
        gate: GATE,
        case: hover ? `${p.id}-hover` : p.id,
        leg: leg.leg,
        points: p.points,
        series: p.series,
      },
      d.presents,
      d.draws,
      d.span,
    );
    return {
      result,
      hovers: n,
      moved: before[0] !== after[0] || before[1] !== after[1],
      engine: await liveCanvas(page, p.id).getAttribute('data-engine'),
      status: await page.locator('html').getAttribute('data-dash-status'),
    };
  } finally {
    await ctx.close();
  }
}

const skipped = (
  leg: BenchLeg,
  p: (typeof PAGES)[number],
  hover: boolean,
  why: 'leg-unavailable',
): BenchResult =>
  summarise(
    {
      gate: GATE,
      case: hover ? `${p.id}-hover` : p.id,
      leg,
      points: p.points,
      series: p.series,
      skipped: why,
    },
    [],
    [],
  );

function sanity(r: Run): void {
  const what = `${r.result.case} ${r.result.leg}`;
  expect.soft(r.engine, `${what}: still on its leg`).toBe(r.result.leg);
  expect.soft(r.status, `${what}: the engine did not fail`).not.toBe('4');
  expect.soft(r.result.frames, `${what}: frames`).toBeGreaterThanOrEqual(MIN_FRAMES);
  if (r.result.case.endsWith('-hover')) {
    expect
      .soft(r.hovers, `${what}: hovers on ≥ 90 % of the steps`)
      .toBeGreaterThanOrEqual(Math.ceil(MIN_HOVER_SHARE * HOVER.length));
  } else {
    expect.soft(r.moved, `${what}: the window moved`).toBe(true);
  }
}

test.describe(GATE, () => {
  test('bench:frame-gallery: every engine page on each leg, script and hover (report only)', async ({
    browser,
    playwright,
  }, info: TestInfo) => {
    test.setTimeout(60 * 60_000);
    const results: BenchResult[] = [];
    const runs: Run[] = [];
    for (const leg of LEGS) {
      let b: Browser | null = browser;
      if (leg.leg === 'wasm-webgpu') {
        b = webgpuReportOnly()
          ? null
          : await playwright.chromium.launch({ channel: 'chromium', args: [...SWIFTSHADER_ARGS] });
      }
      try {
        for (const p of PAGES) {
          for (const hover of [false, true]) {
            const r = b === null ? 'leg-unavailable' : await runCase(b, leg, p, hover);
            if (r === 'leg-unavailable') {
              results.push(skipped(leg.leg, p, hover, r));
              continue;
            }
            results.push(r.result);
            runs.push(r);
          }
        }
      } finally {
        if (b !== null && b !== browser) await b.close();
      }
    }
    await report(info, results);
    for (const r of runs) sanity(r);
    // The gated legs never skip.
    for (const r of results.filter((x) => x.leg !== 'wasm-webgpu'))
      expect.soft(r.skipped, `${r.case} ${r.leg}: not skipped`).toBeUndefined();
    const want = LEGS.flatMap((l) =>
      PAGES.flatMap((p) => [
        { case: p.id, leg: l.leg },
        { case: `${p.id}-hover`, leg: l.leg },
      ]),
    );
    expect(reportGaps(readResults(GATE), want), 'the report').toEqual([]);
  });
});
