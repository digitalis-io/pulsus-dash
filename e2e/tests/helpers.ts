// Shared helpers for the runtime specs: probe access, status waits and canvas pixel checks.
import { inflateSync } from "node:zlib";
import { expect, type Page, type Worker } from "@playwright/test";

/** Mirrors dash_tokens::spike::CANVAS_BG (linear RGBA written as-is to a non-sRGB surface). */
export const CANVAS_BG_8 = [10, 13, 18];

export const STATUS = { BOOTING: "0", T1: "1", T2: "2", STATIC: "3", FAILED: "4", STALE: "5" };

/** The render worker carrying the test probe (`self.__dashProbe`, probe builds only). */
export async function probe(page: Page, timeoutMs = 10_000): Promise<Worker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of page.workers()) {
      const has = await w.evaluate(() => "__dashProbe" in self).catch(() => false);
      if (has) return w;
    }
    await page.waitForTimeout(50);
  }
  throw new Error("no worker exposes the test probe");
}

/** Calls `self.__dashProbe[method](...args)` in the render worker. */
export async function call<T = any>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const w = await probe(page);
  return w.evaluate(
    ([m, a]) => (self as any).__dashProbe[m as string](...(a as unknown[])),
    [method, args] as const,
  );
}

export async function waitStatus(page: Page, status: string, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (s) => document.documentElement.dataset.dashStatus === s,
    status,
    { timeout: timeoutMs },
  );
}

export const htmlData = (page: Page, key: "dashStatus" | "dashMode") =>
  page.evaluate((k) => document.documentElement.dataset[k], key);

/** True when the page has a WebGPU adapter. */
export const hasWebGpuAdapter = (page: Page) =>
  page.evaluate(async () => {
    const gpu = (navigator as any).gpu;
    return !!gpu && (await gpu.requestAdapter()) !== null;
  });

/** A decoded 8-bit RGB or RGBA, non-interlaced PNG (what Playwright screenshots produce). */
export interface Image {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export function decodePng(png: Buffer): Image {
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error("unsupported PNG");
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (!channels) throw new Error(`unsupported PNG colour type ${body[9]}`);
    } else if (type === "IDAT") {
      idat.push(body);
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Fraction of pixels whose RGB differs from CANVAS_BG by more than 8 in any channel. */
export function nonBackgroundFraction(img: Image): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += img.channels) {
    const d = [0, 1, 2].some((k) => Math.abs(img.data[i + k] - CANVAS_BG_8[k]) > 8);
    if (d) n++;
  }
  return n / (img.width * img.height);
}

export const canvasShot = (page: Page) => page.locator("#dash-canvas").screenshot();

/** The canvas is drawn (> 1 % non-background pixels) and animating (two shots 500 ms apart differ). */
export async function expectRendersAndAnimates(page: Page): Promise<void> {
  await expect
    .poll(async () => nonBackgroundFraction(decodePng(await canvasShot(page))), { timeout: 10_000 })
    .toBeGreaterThan(0.01);
  const a = await canvasShot(page);
  await page.waitForTimeout(500);
  const b = await canvasShot(page);
  expect(Buffer.compare(a, b)).not.toBe(0);
}

/** Collects every worker the page creates (attach before navigating). */
export function countWorkers(page: Page): { names: string[] } {
  const seen = { names: [] as string[] };
  page.on("worker", (w) => seen.names.push(w.url()));
  return seen;
}

/** The line scene's probe status (`lineStatus()`, plan #24 §3.7). */
export const lineStatus = (page: Page) => call(page, "lineStatus");

/** Polls `lineStatus()` until `pred` holds. */
export async function waitLine(page: Page, pred: (s: any) => boolean, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await lineStatus(page).catch(() => null);
    if (last && pred(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`lineStatus never matched: ${JSON.stringify(last)}`);
}

/** A line pixel: the line colour (0.20, 0.62, 0.86) at any coverage is greener than red by > 40. */
const isLine = (img: Image, i: number) => img.data[i + 1] - img.data[i] > 40;

/**
 * Fraction of line pixels inside the plot (`lineStatus().plot`: device px, y up from the canvas
 * bottom), optionally only in the right-most `rightPx` CSS px. The screenshot is in CSS px.
 */
export function plotLit(img: Image, s: any, rightPx?: number): number {
  const k = 1 / s.dpr;
  const x0 = Math.ceil(s.plot.x0 * k);
  const x1 = Math.floor((s.plot.x0 + s.plot.w) * k);
  const y1 = img.height - Math.ceil(s.plot.y0 * k);
  const y0 = img.height - Math.floor((s.plot.y0 + s.plot.h) * k);
  const from = rightPx === undefined ? x0 : Math.max(x0, x1 - rightPx);
  let n = 0;
  let lit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = from; x < x1; x++) {
      n++;
      if (isLine(img, (y * img.width + x) * img.channels)) lit++;
    }
  }
  return n ? lit / n : 0;
}
