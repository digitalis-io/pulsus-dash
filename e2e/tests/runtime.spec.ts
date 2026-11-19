// Browser runtime mode matrix (e2e:mode-matrix, T03 §9.2, T03-025) and PRF-005 trace (plan §5).
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import {
  STATUS,
  call,
  countWorkers,
  decodePng,
  canvasShot,
  expectRendersAndAnimates,
  hasWebGpuAdapter,
  htmlData,
  nonBackgroundFraction,
  waitStatus,
} from "./helpers";

const STATIC_TEXT = "Interactive charts unavailable on this browser";
const FAILED_TEXT = "Interactive charts failed. Reload the page.";
const STALE_TEXT = "Pulsus was updated — reload";
const ST_BANNER = "Reduced performance: cross-origin isolation is off (ask your admin)";
const TRACES = path.join(__dirname, "..", "test-results", "traces");

const visibleText = (page: import("@playwright/test").Page, text: string) =>
  expect(page.getByText(text, { exact: true })).toBeVisible();

test("@webgpu webgpu_renders_and_reports_t1", async ({ page }) => {
  await page.goto("/");
  expect(await hasWebGpuAdapter(page), "precondition: WebGPU adapter").toBe(true);
  await waitStatus(page, STATUS.T1);
  expect(await htmlData(page, "dashMode")).toBe("mt");
  await visibleText(page, "Tier: WebGPU (T1)");
  await expectRendersAndAnimates(page);
});

test("@webgl2 webgl2_only_renders_and_reports_t2", async ({ page }) => {
  await page.goto("/");
  // Precondition: no WebGPU adapter (this Chromium keeps `navigator.gpu` under every disable
  // flag, so "absent" is checked as "no adapter"), and WebGL2 on a scratch canvas.
  expect(await hasWebGpuAdapter(page), "precondition: no WebGPU adapter").toBe(false);
  expect(
    await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null),
    "precondition: WebGL2",
  ).toBe(true);
  await waitStatus(page, STATUS.T2);
  await visibleText(page, "Tier: WebGL2 (T2)");
  await expectRendersAndAnimates(page);
});

test("@webgpu forced_modes", async ({ page }) => {
  await page.goto("/?mode=t2");
  await waitStatus(page, STATUS.T2);
  await expect
    .poll(async () => nonBackgroundFraction(decodePng(await canvasShot(page))))
    .toBeGreaterThan(0.01);

  await page.goto("/?mode=static");
  await waitStatus(page, STATUS.STATIC);
  await visibleText(page, STATIC_TEXT);

  const workers = countWorkers(page);
  await page.goto("/?mode=st");
  await waitStatus(page, STATUS.T1);
  expect(await htmlData(page, "dashMode")).toBe("st");
  await visibleText(page, ST_BANNER);
  await page.waitForTimeout(500);
  expect(workers.names.length).toBe(1);
});

test("@nogpu gpu_disabled_shows_fallback", async ({ page }) => {
  await page.goto("/");
  expect(await hasWebGpuAdapter(page), "precondition: no WebGPU adapter").toBe(false);
  expect(
    await page.evaluate(() => document.createElement("canvas").getContext("webgl2") === null),
    "precondition: no WebGL2",
  ).toBe(true);
  await waitStatus(page, STATUS.STATIC);
  await visibleText(page, STATIC_TEXT);
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById("dash-canvas")!).visibility),
  ).toBe("hidden");
});

/** Moves the mouse to 20 points 50 ms apart; returns them. */
async function twentyMoves(page: import("@playwright/test").Page): Promise<[number, number][]> {
  const pts: [number, number][] = [];
  for (let i = 0; i < 20; i++) {
    const p: [number, number] = [40 + 13 * i, 30 + 7 * i];
    pts.push(p);
    await page.mouse.move(p[0], p[1]);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(200);
  return pts;
}

function expectLogged(log: any[], pts: [number, number][]) {
  for (const [x, y] of pts) {
    const hit = log.find((r) => r.kind === 2 && Math.abs(r.x - x) <= 0.5 && Math.abs(r.y - y) <= 0.5);
    expect(hit, `move (${x}, ${y}) in inputLog`).toBeTruthy();
  }
}

test("@noiso not_isolated_runs_st_with_banner", async ({ page }) => {
  const workers = countWorkers(page);
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated), "precondition").toBe(false);
  await waitStatus(page, STATUS.T1);
  expect(await htmlData(page, "dashMode")).toBe("st");
  await visibleText(page, ST_BANNER);
  await expectRendersAndAnimates(page);
  expect(workers.names.length).toBe(1);
  expect(await call(page, "threads")).toEqual({ sharedMemory: false, instancesPublishedBy: "st" });
  const pts = await twentyMoves(page);
  expectLogged(await call(page, "inputLog"), pts);
});

test("@webgpu no_offscreen_maps_to_static", async ({ page }) => {
  await page.addInitScript(() => {
    delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
  });
  const workers = countWorkers(page);
  await page.goto("/");
  await waitStatus(page, STATUS.STATIC);
  await visibleText(page, STATIC_TEXT);
  await page.waitForTimeout(300);
  expect(workers.names.length).toBe(0);
});

test("@webgpu boot_failure_shows_message", async ({ page }) => {
  await page.route("**/dash_core_mt.js", (r) => r.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await waitStatus(page, STATUS.FAILED, 11_000);
  await visibleText(page, FAILED_TEXT);
});

test("@webgpu stale_layout_stops", async ({ page }) => {
  await page.route("**/layout.gen.js", async (r) => {
    const res = await r.fetch();
    const body = (await res.text()).replace("LAYOUT_VERSION = 1;", "LAYOUT_VERSION = 2;");
    await r.fulfill({ response: res, body });
  });
  const closed: string[] = [];
  page.on("worker", (w) => w.on("close", () => closed.push(w.url())));
  const workers = countWorkers(page);
  await page.goto("/");
  await waitStatus(page, STATUS.STALE);
  await visibleText(page, STALE_TEXT);
  await expect.poll(() => closed.length).toBe(workers.names.length);
  expect(workers.names.length).toBeGreaterThan(0);
});

/** Records the original canvas before boot.js runs (readyState "interactive" precedes modules). */
const keepOriginalCanvas = () => {
  document.addEventListener("readystatechange", () => {
    (window as any).__origCanvas ??= document.getElementById("dash-canvas");
  });
};

test("@webgpu webgpu_fault_before_surface_falls_back_in_place", async ({ page }) => {
  await page.addInitScript(keepOriginalCanvas);
  const workers = countWorkers(page);
  await page.goto("/?fault=webgpu-device");
  await waitStatus(page, STATUS.T2);
  await expectRendersAndAnimates(page);
  expect(await page.evaluate(() => (window as any).__origCanvas.isConnected)).toBe(true);
  await page.waitForTimeout(300);
  expect(workers.names.length).toBe(2);
});

test("@webgpu webgpu_fault_after_surface_restarts_on_fresh_canvas", async ({ page }) => {
  await page.addInitScript(keepOriginalCanvas);
  const workers = countWorkers(page);
  await page.goto("/?fault=webgpu-surface");
  await waitStatus(page, STATUS.T2);
  await expectRendersAndAnimates(page);
  expect(await page.evaluate(() => (window as any).__origCanvas.isConnected)).toBe(false);
  expect(await page.locator("#dash-canvas").count()).toBe(1);
  await page.waitForTimeout(300);
  expect(workers.names.length).toBe(3);
});

test("@webgpu render_and_data_share_memory", async ({ page }) => {
  const workers = countWorkers(page);
  await page.goto("/");
  await waitStatus(page, STATUS.T1);
  await expect
    .poll(() => call(page, "threads"))
    .toEqual({ sharedMemory: true, instancesPublishedBy: "data-0" });
  expect(workers.names.length).toBe(2);
  const threw = await page.evaluate(() => {
    try {
      (document.getElementById("dash-canvas") as HTMLCanvasElement).getContext("2d");
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(true);
});

test("@webgpu scene_is_wgpu_canvas_only", async ({ page }) => {
  await page.goto("/");
  await waitStatus(page, STATUS.T1);
  expect(await page.locator("canvas").count()).toBe(1);
  expect(await page.locator("svg").count()).toBe(0);
  const transferred = await page.evaluate(() => {
    try {
      (document.getElementById("dash-canvas") as HTMLCanvasElement).transferControlToOffscreen();
      return false;
    } catch {
      return true;
    }
  });
  expect(transferred).toBe(true);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  expect(pkg.dependencies).toBeUndefined();
});

test("@webgpu input_drained_by_next_frame", async ({ page }) => {
  await page.goto("/");
  await waitStatus(page, STATUS.T1);
  const pts = await twentyMoves(page);
  const log: any[] = await call(page, "inputLog");
  const starts: { frame: number; tMainMs: number }[] = await call(page, "frameStarts");
  expectLogged(log, pts);
  const startOf = new Map(starts.map((s) => [s.frame, s.tMainMs]));
  for (const r of log.filter((r) => r.kind === 2)) {
    const consumed = startOf.get(r.frame);
    if (consumed === undefined) continue;
    const between = starts.filter((s) => s.tMainMs > r.tMs && s.tMainMs < consumed).length;
    expect(between, `record ${r.seq} at ${r.tMs} consumed by frame ${r.frame}`).toBeLessThanOrEqual(1);
  }
});

test("@webgpu ring_overflow_end_to_end", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await waitStatus(page, STATUS.T1);
  await call(page, "pauseInput", true);
  for (let i = 0; i < 1700; i++) await page.mouse.move(20 + (i % 400), 20 + (i % 300));
  for (let i = 0; i < 600; i++) await page.mouse.click(100 + (i % 50), 100);
  const overflow: number = await call(page, "overflowCount");
  expect(overflow, "precondition: the ring overflowed").toBeGreaterThan(0);
  await call(page, "pauseInput", false);
  await page.evaluate(
    () => new Promise<void>((r) => {
      let n = 0;
      const f = () => (++n >= 10 ? r() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    }),
  );
  await page.waitForTimeout(500);
  await page.mouse.click(300, 200);
  await page.waitForTimeout(300);
  const log: any[] = await call(page, "inputLog");
  const seqs = log.map((r) => r.seq);
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  const lastDown = log.filter((r) => r.kind === 1).at(-1);
  const discreteBefore = log.filter((r) => (r.kind === 1 || r.kind === 3) && r.seq < lastDown.seq);
  expect(discreteBefore.length + (await call<number>(page, "overflowCount"))).toBe(1200);
  expect(lastDown.flags & 8).toBe(8);
});

test("@webgpu @webgl2 @noiso main_thread_trace_during_interaction", async ({ page, browser }, info) => {
    await page.goto("/");
    await page.waitForFunction(() => ["1", "2"].includes(document.documentElement.dataset.dashStatus!));
    const before: number = (await call(page, "frameStats")).frames;
    await browser.startTracing(page, {
      categories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline"],
    });
    // At least 5 s of interaction, and until the scene presented 100 frames (software GPUs in
    // CI render the 10 000-instance scene at ~10 fps; the frame count is not a frame-rate gate,
    // T05-006).
    const start = Date.now();
    for (let i = 0; ; i++) {
      await page.mouse.move(50 + (i % 300), 50 + ((i * 7) % 200));
      await page.waitForTimeout(16);
      if (i % 30 === 29 && Date.now() - start >= 5_000) {
        const now: number = (await call(page, "frameStats")).frames;
        if (now - before >= 100 || Date.now() - start > 40_000) break;
      }
    }
    const trace = await browser.stopTracing();
    fs.mkdirSync(TRACES, { recursive: true });
    const file = path.join(TRACES, `long-tasks-${info.project.name}.json`);
    fs.writeFileSync(file, trace);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    const after: number = (await call(page, "frameStats")).frames;
    expect(after - before).toBeGreaterThanOrEqual(100);
});

test("@webgpu frame_timing_exported", async ({ page }) => {
  await page.goto("/");
  await waitStatus(page, STATUS.T1);
  await page.waitForTimeout(2_000);
  // ≥ 30 frames: waited for, as software GPUs in CI present the scene at ~10 fps (T05-006).
  await expect.poll(async () => (await call(page, "frameStats")).frames, { timeout: 15_000 }).toBeGreaterThanOrEqual(30);
  const s = await call(page, "frameStats");
  expect(s.frames).toBeGreaterThanOrEqual(30);
  expect(s.hist.length).toBe(64);
  expect(s.hist.reduce((a: number, b: number) => a + b, 0)).toBe(s.frames);
  expect(s.intervalsMs.length).toBeGreaterThan(0);
  expect(s.intervalsMs.every((v: number) => v > 0)).toBe(true);
  expect(s.cpuMs.every((v: number) => v > 0)).toBe(true);
});
