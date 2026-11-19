// The line chart at 10⁸ points (plan #24 §5, tests 50–58): e2e:mode-matrix legs of the line scene
// and the bench:frame-line-1e8 CI report.
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { STATUS, call, canvasShot, decodePng, htmlData, lineStatus, plotLit, waitLine, waitStatus, type Image } from "./helpers";

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

/** Whether the CSS-px screenshot has line colour (G ≥ 100) within ±1 px of value `v` in column `x`. */
function lineAt(img: Image, s: any, x: number, v: number): boolean {
  const k = 1 / s.dpr;
  const yDev = (v - s.camera.vBottom) / s.camera.vPerPx;
  const row = Math.round(img.height - (s.plot.y0 + yDev) * k - 0.5);
  for (let y = row - 1; y <= row + 1; y++) {
    if (y < 0 || y >= img.height) continue;
    if (img.data[(y * img.width + x) * img.channels + 1] >= 100) return true;
  }
  return false;
}

test("@webgl2 line_t2_texture_budget", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?scene=line&series=672&points=100000&fault=line-ramps");
  await waitStatus(page, STATUS.T2, 20_000);
  // The T2 budget (256 MiB per texture) holds 4 value layers: 671 series of 100 000.
  const s = await waitLine(page, (s) => s.uploaded === 671 && s.draws.line === 1, 150_000);
  expect(s.valueLayers).toBe(4);
  expect(s.coverage.drawn).toBe(671);
  expect(s.coverage.reasons).toContain("texture-ceiling");
  await visibleText(page, TEXT["texture-ceiling"]);
  await page.waitForTimeout(1_000);
  const st = await lineStatus(page);
  const img = decodePng(await canvasShot(page));
  const k = 1 / st.dpr;
  const first = Math.ceil(st.plot.x0 * k);
  const last = Math.floor((st.plot.x0 + st.plot.w) * k) - 1;
  // Series 0 ramps 0 → 100 and series 670 ramps 300 → 400; series 671 (200 → 250) is not drawn.
  // Values read as zero would draw them flat at 50 and 350 instead.
  expect(lineAt(img, st, first, 0), "y(0), first column").toBe(true);
  expect(lineAt(img, st, first, 300), "y(300), first column").toBe(true);
  expect(lineAt(img, st, last, 100), "y(100), last column").toBe(true);
  expect(lineAt(img, st, last, 400), "y(400), last column").toBe(true);
  expect(lineAt(img, st, first, 200), "y(200), first column").toBe(false);
  expect(lineAt(img, st, last, 250), "y(250), last column").toBe(false);
});

test("@webgpu line_load_failure_shown", async ({ page }) => {
  await page.goto("/?scene=line&series=20&points=20000&fault=line-wire");
  await waitStatus(page, STATUS.T1);
  const s = await waitLine(page, (s) => s.loadFailed && s.uploaded === 6);
  expect(s.published).toBe(6);
  await visibleText(page, TEXT["load-failed"]);
  expect(await htmlData(page, "dashStatus")).toBe(STATUS.T1);
});

/**
 * Scripted pan/zoom loop of plan §4.8 until `untilMs` (Date.now()) and at least `minFrames` frames
 * since `fromFrame` (a report needs 10 intervals). Both are checked before every input step: on a
 * software GPU a 10⁸-point frame can take seconds, and each input waits for the page's next frame.
 */
async function benchLoop(page: Page, untilMs: number, fromFrame: number, minFrames: number) {
  const vp = page.viewportSize()!;
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  const late = async () =>
    Date.now() >= untilMs && (await call(page, "frameStats")).frames - fromFrame >= minFrames;
  const steps: (() => Promise<void>)[] = [];
  steps.push(() => page.mouse.move(cx, cy), () => page.mouse.down());
  for (let i = 1; i <= 20; i++) {
    steps.push(async () => {
      await page.mouse.move(cx - 20 * i, cy);
      await page.waitForTimeout(25);
    });
  }
  steps.push(() => page.mouse.up(), () => page.mouse.move(cx + 100, cy));
  for (let i = 0; i < 10; i++) steps.push(() => page.mouse.wheel(0, -120));
  steps.push(() => page.mouse.move(cx, cy), () => page.mouse.down());
  for (let i = 1; i <= 3; i++) steps.push(() => page.mouse.move(cx + 100 * i, cy));
  steps.push(() => page.mouse.up(), () => page.waitForTimeout(400), () => page.mouse.move(cx + 100, cy));
  for (let i = 0; i < 10; i++) steps.push(() => page.mouse.wheel(0, 120));
  while (!(await late())) {
    for (const step of steps) {
      if (await late()) break;
      await step();
    }
  }
  await page.mouse.up();
}

test("@webgpu line_1e8_pan_zoom", async ({ page, browser }) => {
  const lab = process.env.DASH_BENCH_PROFILE === "lab";
  const loopMs = Number(process.env.DASH_BENCH_MS ?? (lab ? 60_000 : 20_000));
  const warmupMs = lab ? 30_000 : 5_000;
  const runs = lab ? 3 : 1;
  // Load (≤ 10 min) + warm-up + loop, plus headroom for the last input steps on a slow GPU.
  test.setTimeout(20 * 60_000 + runs * loopMs + warmupMs);
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
  for (let r = 0; r < runs; r++) await benchLoop(page, Date.now() + loopMs, before, 12);
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
  // Let the software GPU finish this page's frames before the next test starts.
  await page.goto("about:blank");
  await page.waitForTimeout(3_000);
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
  // One series: the software GPU of CI then draws well above 10 fps, so the ~300 ms of inertia
  // spans several frames.
  await page.goto("/?scene=line&series=1&points=20000");
  await waitStatus(page, STATUS.T1);
  await waitLine(page, (s) => s.uploaded === 1 && s.draws.line === 1);
  // 300 px in 5 steps over 50 ms, released while moving. The events carry explicit timestamps
  // (CDP), 300 ms ahead of dispatch, so the release velocity (measured over the last 50 ms, plan
  // §4.5) and the inertia clock do not depend on how fast the software GPU lets the browser
  // deliver input.
  const cdp = await page.context().newCDPSession(page);
  const mouse = (type: string, x: number, t: number, buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y: 300,
      button: "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      timestamp: t,
    });
  const flick = async () => {
    const t0 = Date.now() / 1000 + 0.3;
    await mouse("mouseMoved", 300, t0, 0);
    await mouse("mousePressed", 300, t0 + 0.001, 1);
    for (let i = 1; i <= 5; i++) await mouse("mouseMoved", 300 + 60 * i, t0 + 0.001 + 0.01 * i, 1);
    await mouse("mouseReleased", 600, t0 + 0.052, 0);
  };
  const sample = async (ms: number) => {
    const out: { frame: number; t: number; moving: boolean }[] = [];
    const start = Date.now();
    while (Date.now() - start < ms) {
      const s = await lineStatus(page);
      out.push({ frame: await frames(page), t: s.camera.tLeftRelMs, moving: s.camera.moving });
      await page.waitForTimeout(15);
    }
    return out;
  };

  await flick();
  const samples = await sample(1_500);
  const log: any[] = await call(page, "inputLog");
  const up = log.filter((r) => r.kind === 3).at(-1);
  const starts: { frame: number; tMainMs: number }[] = await call(page, "frameStarts");
  const moved = samples.filter((s, i) => i > 0 && s.frame >= up.frame + 3 && s.t !== samples[i - 1].t);
  expect(moved.length, `camera moves 3+ frames after the Up (frame ${up.frame})`).toBeGreaterThan(0);
  // Settled (no further motion, no overshoot back) by 500 ms after the release.
  const by500 = starts.find((f) => f.tMainMs >= up.tMs + 500)!.frame;
  const late = samples.filter((s) => s.frame >= by500).map((s) => s.t);
  expect(late.length).toBeGreaterThan(0);
  expect(new Set(late).size, JSON.stringify(samples)).toBe(1);
  const ts = samples.map((s) => s.t);
  expect(ts.every((t, i) => i === 0 || t <= ts[i - 1]), "monotone").toBe(true);

  // A second flick, interrupted by a press while it moves: the camera stops at once.
  await flick();
  await expect.poll(async () => (await lineStatus(page)).camera.moving, { timeout: 5_000 }).toBe(true);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await expect.poll(async () => (await lineStatus(page)).camera.moving).toBe(false);
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
