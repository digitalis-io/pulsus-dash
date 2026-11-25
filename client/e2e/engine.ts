/**
 * Helpers of the engine specs (plan #68 C1 §5): the live canvas of a gallery frame, the engine's
 * `<html>` status, device-scale canvas screenshots decoded to RGBA, and `dash-golden compare`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { frame, GALLERY_IDS, GALLERY_URL, galleryReady } from './helpers.ts';

export const ENGINE_URL = `${GALLERY_URL}&engine=wasm`;
/** The gallery entries the engine draws (line specs); the rest stay on Canvas 2D (D-ROUTE). */
export const LINE_IDS = GALLERY_IDS.filter((id) => id.startsWith('line-'));
export const NOTICE = 'Recovered from an error: this chart uses the basic renderer.';

/** The canvas a gallery frame draws on now (a retired one stays, hidden). */
export function liveCanvas(page: Page, id: string): Locator {
  return frame(page, id).locator('canvas:not([data-retired])');
}

export async function engines(page: Page): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of GALLERY_IDS) out[id] = await liveCanvas(page, id).getAttribute('data-engine');
  return out;
}

/** Every frame ready (a11y), nothing pending, the fonts loaded, two animation frames later. */
export async function framesReady(page: Page): Promise<void> {
  await galleryReady(page);
  await expect(page.locator('[data-chart-pending]')).toHaveCount(0);
}

/** Requests for engine artefacts (`assets/dash-engine-*`). */
export function engineRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (/\/assets\/dash-engine-/.test(r.url())) seen.push(r.url());
  });
  return seen;
}

export interface Rgba {
  w: number;
  h: number;
  px: Uint8Array;
}

/** A non-interlaced 8-bit RGB or RGBA PNG (Playwright's screenshots) to RGBA. */
export function decodePng(png: Buffer): Rgba {
  let at = 8;
  let w = 0;
  let h = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const colour = data[9];
      if (data[8] !== 8 || (colour !== 2 && colour !== 6) || data[12] !== 0) {
        throw new Error('unsupported PNG');
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const rows = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0;
      const p = a + b - c;
      const pr =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f] ?? 0;
      rows[y * stride + x] = ((src[x] ?? 0) + pred) & 0xff;
    }
  }
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 3; k++) px[i * 4 + k] = rows[i * channels + k] ?? 0;
    px[i * 4 + 3] = channels === 4 ? (rows[i * channels + 3] ?? 255) : 255;
  }
  return { w, h, px };
}

/** The plot rect of a ready frame, CSS px (`data-plot`). */
export async function plotRect(page: Page, id: string): Promise<number[]> {
  const f = frame(page, id);
  await expect(f).toHaveAttribute('data-frame-ready', 'true');
  return ((await f.getAttribute('data-plot')) ?? '').split(',').map(Number);
}

/** Pixels of the plot that differ from its first pixel (the background), device px. */
export async function plotInk(page: Page, id: string): Promise<number> {
  const shot = decodePng(await liveCanvas(page, id).screenshot({ scale: 'device' }));
  const dpr = await page.evaluate(() => devicePixelRatio);
  const [x = 0, y = 0, w = 0, h = 0] = await plotRect(page, id);
  const x0 = Math.floor(x * dpr);
  const y0 = Math.floor(y * dpr);
  const bg = shot.px.subarray((y0 * shot.w + x0) * 4, (y0 * shot.w + x0) * 4 + 3);
  let n = 0;
  for (let yy = y0; yy < Math.min(shot.h, Math.ceil((y + h) * dpr)); yy++) {
    for (let xx = x0; xx < Math.min(shot.w, Math.ceil((x + w) * dpr)); xx++) {
      const i = (yy * shot.w + xx) * 4;
      if (Math.abs((shot.px[i] ?? 0) - (bg[0] ?? 0)) + Math.abs((shot.px[i + 1] ?? 0) - (bg[1] ?? 0)) + Math.abs((shot.px[i + 2] ?? 0) - (bg[2] ?? 0)) > 24) n++;
    }
  }
  return n;
}

/** A device-scale screenshot of a frame's live canvas, written under the test's output. */
export async function canvasShot(page: Page, id: string, info: TestInfo, name: string): Promise<string> {
  const path = info.outputPath(`${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await liveCanvas(page, id).screenshot({ scale: 'device' }));
  return path;
}

/**
 * `dash-golden compare` over the plot rect (edges included) with the engine golden limits
 * (T05-005): the exit code, 0 = within both.
 */
export function compareShots(a: string, b: string, plot: number[], dpr: number): { code: number; out: string } {
  const bin = process.env['DASH_GOLDEN_BIN'];
  if (bin === undefined || bin === '') throw new Error('DASH_GOLDEN_BIN is not set');
  const [x = 0, y = 0, w = 0, h = 0] = plot;
  const x0 = Math.floor(x * dpr);
  const y0 = Math.floor(y * dpr);
  const region = [x0, y0, Math.ceil((x + w) * dpr) - x0 + 1, Math.ceil((y + h) * dpr) - y0 + 1].join(',');
  const r = spawnSync(bin, ['compare', a, b, '--region', region, '--max', '0.005', '--tile-max', '0.25'], {
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
