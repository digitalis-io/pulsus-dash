// The line chart at 10⁸ points (plan #24 §5, tests 50–58): e2e:mode-matrix legs of the line scene
// and the bench:frame-line-1e8 CI report.
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { STATUS, call, canvasShot, decodePng, htmlData, lineStatus, plotLit, waitLine, waitStatus } from "./helpers";

const TRACES = path.join(__dirname, "..", "test-results", "traces");
const SMALL = "/?scene=line&series=20&points=20000";
const TEXT = {
  loading: "Loading data: not every series is drawn yet",
  "st-ceiling": "Not every series is shown: single-thread mode limit",
  "texture-ceiling": "Not every series is shown: GPU texture limit",
  "load-failed": "Some series failed to load",
};

const visibleText = (page: Page, text: string) => expect(page.getByText(text, { exact: true })).toBeVisible();
const coverageAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.dashCoverage);
const lit = async (page: Page, s: any, rightPx?: number) => plotLit(decodePng(await canvasShot(page)), s, rightPx);

test("@webgpu line_renders_t1", async ({ page }) => {
  await page.goto(SMALL);
  await waitStatus(page, STATUS.T1);
  const s = await waitLine(page, (s) => s.uploaded === 20 && s.draws.line === 1);
  expect(s.pointsHeld).toBe(400_000);
  expect(s.decimation).toBe("compute");
  expect(s.publishedBy).toBe("data-0");
  expect(s.draws).toEqual({ line: 1, segment: 1 });
  await expect.poll(() => lit(page, s), { timeout: 10_000 }).toBeGreaterThan(0.005);
  await expect.poll(() => coverageAttr(page)).toBe("");
});

test("@webgl2 line_renders_t2", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(SMALL);
  await waitStatus(page, STATUS.T2, 20_000);
  let s = await waitLine(page, (s) => s.uploaded === 20 && s.draws.line === 1, 60_000);
  expect(s.decimation).toBe("fragment");
  expect(s.draws).toEqual({ line: 1, segment: 1 });
  await expect.poll(() => lit(page, s), { timeout: 10_000 }).toBeGreaterThan(0.005);
  await page.setViewportSize({ width: 3000, height: 600 });
  s = await waitLine(page, (s) => s.plot.w > 2_900 * s.dpr && s.draws.line === 1, 20_000);
  await expect.poll(() => lit(page, s, 100), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);
  expect(await htmlData(page, "dashStatus")).toBe(STATUS.T2);
  expect(await call(page, "status")).toBe(2);
  expect((await lineStatus(page)).draws).toEqual({ line: 1, segment: 1 });
});

test("@noiso line_st_ceiling", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/?scene=line&series=200&points=100000");
  await waitStatus(page, STATUS.T1, 60_000);
  expect(await htmlData(page, "dashMode")).toBe("st");
  const s = await waitLine(page, (s) => s.uploaded === 100, 120_000);
  expect(s.held).toBe(100);
  expect(s.requested).toBe(200);
  expect(s.pointsHeld).toBe(10_000_000);
  expect(s.publishedBy).toBe("st");
  await visibleText(page, TEXT["st-ceiling"]);
});

test("@webgpu line_texture_ceiling_shown", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?scene=line&series=20&points=1000000&fault=line-layers-1");
  await waitStatus(page, STATUS.T1);
  const s = await waitLine(page, (s) => s.uploaded === 16, 90_000);
  expect(s.coverage.drawn).toBe(16);
  expect(s.coverage.reasons).toContain("texture-ceiling");
  await visibleText(page, TEXT["texture-ceiling"]);
});

test("@webgpu line_load_failure_shown", async ({ page }) => {
  await page.goto("/?scene=line&series=20&points=20000&fault=line-wire");
  await waitStatus(page, STATUS.T1);
  const s = await waitLine(page, (s) => s.loadFailed && s.uploaded === 6);
  expect(s.published).toBe(6);
  await visibleText(page, TEXT["load-failed"]);
  expect(await htmlData(page, "dashStatus")).toBe(STATUS.T1);
});

/** Scripted pan/zoom loop of plan §4.8 until `untilMs` (Date.now()). */
async function benchLoop(page: Page, untilMs: number) {
  const vp = page.viewportSize()!;
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  while (Date.now() < untilMs) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(cx - 20 * i, cy);
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    await page.mouse.move(cx + 100, cy);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -120);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 3; i++) await page.mouse.move(cx + 100 * i, cy);
    await page.mouse.up();
    await page.waitForTimeout(400);
    await page.mouse.move(cx + 100, cy);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120);
  }
}

test("@webgpu line_1e8_pan_zoom", async ({ page, browser }) => {
  const lab = process.env.DASH_BENCH_PROFILE === "lab";
  const loopMs = Number(process.env.DASH_BENCH_MS ?? (lab ? 60_000 : 20_000));
  const warmupMs = lab ? 30_000 : 5_000;
  const runs = lab ? 3 : 1;
  test.setTimeout(15 * 60_000 + runs * loopMs + warmupMs);
  await page.setViewportSize({ width: 1280, height: 720 });
  const t0 = Date.now();
  await page.goto("/?scene=line");
  await waitStatus(page, STATUS.T1, 60_000);
  const loaded = await waitLine(page, (s) => s.uploaded === 1000, 10 * 60_000);
  const loadMs = Date.now() - t0;
  expect(loaded.pointsHeld).toBe(100_000_000);
  await page.waitForTimeout(warmupMs);
  const cam0 = (await lineStatus(page)).camera;
  const before: number = (await call(page, "frameStats")).frames;
  const intervals: number[] = [];
  let seen = before;
  const collect = async () => {
    const fs_ = await call(page, "frameStats");
    const fresh = Math.min(fs_.frames - seen, fs_.intervalsMs.length);
    if (fresh > 0) intervals.push(...fs_.intervalsMs.slice(fs_.intervalsMs.length - fresh));
    seen = fs_.frames;
  };
  await browser.startTracing(page, {
    categories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline"],
  });
  const timer = setInterval(() => void collect().catch(() => undefined), 500);
  for (let r = 0; r < runs; r++) await benchLoop(page, Date.now() + loopMs);
  clearInterval(timer);
  await collect();
  const trace = await browser.stopTracing();
  const after = await lineStatus(page);
  fs.mkdirSync(TRACES, { recursive: true });
  fs.writeFileSync(path.join(TRACES, "long-tasks-line-1e8.json"), trace);
  const report = {
    scene: "line",
    series: 1000,
    points: 100_000,
    tier: Number(await htmlData(page, "dashStatus")),
    decimation: after.decimation,
    warmupMs,
    loopMs: runs * loopMs,
    loadMs,
    intervalsMs: intervals,
  };
  fs.writeFileSync(path.join(TRACES, "frame-line-1e8.json"), JSON.stringify(report));
  expect(await htmlData(page, "dashStatus")).toBe(STATUS.T1);
  expect((await call(page, "frameStats")).frames - before).toBeGreaterThanOrEqual(10);
  expect(after.camera).not.toEqual(cam0);
  expect(fs.statSync(path.join(TRACES, "frame-line-1e8.json")).size).toBeGreaterThan(0);
  expect(fs.statSync(path.join(TRACES, "long-tasks-line-1e8.json")).size).toBeGreaterThan(0);
});

test("@webgpu line_wheel_zoom_anchored", async ({ page }) => {
  await page.goto(SMALL);
  await waitStatus(page, STATUS.T1);
  const s0 = await waitLine(page, (s) => s.uploaded === 20 && s.draws.line === 1);
  const px = 400 * s0.dpr - s0.plot.x0;
  const t = s0.camera.tLeftRelMs + px * s0.camera.msPerPx;
  await page.mouse.move(400, 200);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  const s1 = await waitLine(page, (s) => s.camera.msPerPx < s0.camera.msPerPx * 0.5, 10_000);
  const px1 = (t - s1.camera.tLeftRelMs) / s1.camera.msPerPx;
  expect(Math.abs(px1 - px)).toBeLessThan(1);
});

const tLeft = async (page: Page) => (await lineStatus(page)).camera.tLeftRelMs as number;
const frames = async (page: Page) => (await call(page, "frameStats")).frames as number;

test("@webgpu line_flick_and_interrupt", async ({ page }) => {
  await page.goto(SMALL);
  await waitStatus(page, STATUS.T1);
  await waitLine(page, (s) => s.uploaded === 20 && s.draws.line === 1);
  const flick = async () => {
    await page.mouse.move(300, 300);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(300 + 60 * i, 300);
      await page.waitForTimeout(10);
    }
    await page.mouse.up();
  };
  await flick();
  const atUp = await tLeft(page);
  const f0 = await frames(page);
  await expect.poll(() => frames(page)).toBeGreaterThanOrEqual(f0 + 3);
  await expect.poll(() => tLeft(page), { timeout: 2_000 }).not.toBe(atUp);
  await page.waitForTimeout(500);
  const settled = await tLeft(page);
  await page.waitForTimeout(200);
  expect(await tLeft(page)).toBe(settled);

  await flick();
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(100);
  const a = await tLeft(page);
  await page.waitForTimeout(200);
  expect(await tLeft(page)).toBe(a);
  await page.mouse.up();
});

test("@webgpu wire_check_in_wasm32", async ({ page }) => {
  await page.goto(SMALL);
  await waitStatus(page, STATUS.T1);
  const cases: { name: string; got: string; expected: string }[] = await call(page, "wireCases");
  expect(cases.length).toBe(4);
  for (const c of cases) expect(c.got, c.name).toBe(c.expected);
  const f0 = await frames(page);
  await expect.poll(() => frames(page)).toBeGreaterThan(f0);
  expect(await call(page, "status")).toBe(1);
});
