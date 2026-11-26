/**
 * Helpers of the engine specs (plan #68 C1 §5): the two projects' tiers, the WebGPU leg's
 * report-only switch (`engine-legs.json`), the live canvas of a gallery frame, device-scale canvas
 * screenshots decoded to RGBA, and `dash-golden compare`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { frame, GALLERY_IDS, GALLERY_URL, galleryReady } from './helpers.ts';
import { decodePng } from './png.ts';

export const ENGINE_URL = `${GALLERY_URL}&engine=wasm`;

/** The engine tier a project runs (playwright.engine.config.ts). */
export interface Tier {
  /** The engine flags of the gallery URL. */
  readonly query: string;
  readonly engine: 'wasm-webgl2' | 'wasm-webgpu';
  readonly status: '1' | '2';
  readonly adapter: RegExp;
  /** Gated pixel goldens (false: report-only). */
  readonly goldens: boolean;
}

export const TIERS: Readonly<Record<string, Tier>> = {
  lavapipe: {
    query: '&engine=wasm&mode=t2',
    engine: 'wasm-webgl2',
    status: '2',
    adapter: /llvmpipe/,
    goldens: true,
  },
  swiftshader: {
    query: '&engine=wasm',
    engine: 'wasm-webgpu',
    status: '1',
    adapter: /swiftshader/i,
    goldens: false,
  },
};

export function tierOf(info: TestInfo): Tier {
  const t = TIERS[info.project.name];
  if (t === undefined) throw new Error(`no engine tier for project ${info.project.name}`);
  return t;
}

/**
 * `engine-legs.json` (plan #68 C1 §5.1): present only when Dawn's SwiftShader cannot render in the
 * image; it makes the `swiftshader` project's failures soft, with its reason printed.
 */
export const LEGS: { readonly webgpu?: string; readonly reason?: string } = (() => {
  const p = new URL('engine-legs.json', import.meta.url);
  return existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf8')) as { webgpu?: string; reason?: string })
    : {};
})();

/** The WebGPU leg is report-only (`engine-legs.json`). */
export function webgpuReportOnly(): boolean {
  return LEGS.webgpu === 'report';
}

/**
 * Runs a test body; in the `swiftshader` project with the WebGPU leg report-only, a failure is
 * printed and annotated instead of failing the test.
 */
export async function leg(info: TestInfo, body: () => Promise<void>): Promise<void> {
  if (info.project.name !== 'swiftshader' || !webgpuReportOnly()) {
    await body();
    return;
  }
  try {
    await body();
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
    const line = `WebGPU leg report-only (${LEGS.reason ?? 'no reason'}): ${info.title}: ${msg}`;
    console.log(line);
    info.annotations.push({ type: 'report-only', description: line });
  }
}
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

export { decodePng, type Rgba } from './png.ts';

/** The plot rect of a ready frame, CSS px (`data-plot`). */
export async function plotRect(page: Page, id: string): Promise<number[]> {
  const f = frame(page, id);
  await expect(f).toHaveAttribute('data-frame-ready', 'true');
  return ((await f.getAttribute('data-plot')) ?? '').split(',').map(Number);
}

/** Pixels of the plot that differ from its first pixel (the background), device px. */
export async function plotInk(page: Page, id: string): Promise<number> {
  const shot = decodePng(await canvasPng(page, id));
  const dpr = await page.evaluate(() => devicePixelRatio);
  const [x = 0, y = 0, w = 0, h = 0] = await plotRect(page, id);
  const x0 = Math.floor(x * dpr);
  const y0 = Math.floor(y * dpr);
  const bg = shot.px.subarray((y0 * shot.w + x0) * 4, (y0 * shot.w + x0) * 4 + 3);
  let n = 0;
  for (let yy = y0; yy < Math.min(shot.h, Math.ceil((y + h) * dpr)); yy++) {
    for (let xx = x0; xx < Math.min(shot.w, Math.ceil((x + w) * dpr)); xx++) {
      const i = (yy * shot.w + xx) * 4;
      if (
        Math.abs((shot.px[i] ?? 0) - (bg[0] ?? 0)) +
          Math.abs((shot.px[i + 1] ?? 0) - (bg[1] ?? 0)) +
          Math.abs((shot.px[i + 2] ?? 0) - (bg[2] ?? 0)) >
        24
      )
        n++;
    }
  }
  return n;
}

/** A device-scale screenshot of a frame's live canvas, written under the test's output. */
/**
 * A device-scale screenshot of a frame's live canvas, clipped to its box rounded to whole CSS px,
 * so the image is `round(css × dpr)` even when the box starts at a fractional page position (an
 * element screenshot would take the extra partly covered row).
 */
export async function canvasPng(page: Page, id: string): Promise<Buffer> {
  const canvas = liveCanvas(page, id);
  // The clip is in viewport coordinates: the whole canvas must be in view.
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error(`${id}: the canvas has no box`);
  // The canvas alone: ChartFrame's overlays (notices, the crosshair) hidden through CSSOM.
  const hide = (on: boolean) =>
    canvas.evaluate((c, hidden) => {
      for (const el of c.parentElement?.children ?? []) {
        if (el !== c) (el as HTMLElement).style.visibility = hidden ? 'hidden' : '';
      }
    }, on);
  await hide(true);
  try {
    return await page.screenshot({
      scale: 'device',
      clip: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
    });
  } finally {
    await hide(false);
  }
}

export async function canvasShot(
  page: Page,
  id: string,
  info: TestInfo,
  name: string,
): Promise<string> {
  const path = info.outputPath(`${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await canvasPng(page, id));
  return path;
}

function goldenBin(): string {
  const bin = process.env['DASH_GOLDEN_BIN'];
  if (bin === undefined || bin === '') throw new Error('DASH_GOLDEN_BIN is not set');
  return bin;
}

/**
 * `dash-golden compare a b` with `--max`, optionally `--tile-max` and a region (CSS px rect,
 * edges included, at `dpr`): the exit code (0 = within) and the printed means.
 */
export function compareImages(
  a: string,
  b: string,
  o: { max: number; tileMax?: number; plot?: number[]; dpr?: number },
): { code: number; out: string } {
  const args = ['compare', a, b, '--max', String(o.max)];
  if (o.tileMax !== undefined) args.push('--tile-max', String(o.tileMax));
  if (o.plot !== undefined) {
    const dpr = o.dpr ?? 1;
    const [x = 0, y = 0, w = 0, h = 0] = o.plot;
    const x0 = Math.floor(x * dpr);
    const y0 = Math.floor(y * dpr);
    const region = [x0, y0, Math.ceil((x + w) * dpr) - x0 + 1, Math.ceil((y + h) * dpr) - y0 + 1];
    args.push('--region', region.join(','));
  }
  const r = spawnSync(goldenBin(), args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** `dash-golden render` of a gallery line page (the native lavapipe renderer, plan #68 C1). */
export function nativeRender(o: {
  page: string;
  theme: string;
  css: readonly [number, number];
  dpr: number;
  tier: 't1' | 't2';
  out: string;
}): void {
  const r = spawnSync(
    goldenBin(),
    [
      'render',
      '--page',
      o.page,
      '--theme',
      o.theme,
      '--size',
      `${String(o.css[0])}x${String(o.css[1])}`,
      '--dpr',
      String(o.dpr),
      '--tier',
      o.tier,
      '--out',
      o.out,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`dash-golden render ${o.page}: ${r.stdout}${r.stderr}`);
}
