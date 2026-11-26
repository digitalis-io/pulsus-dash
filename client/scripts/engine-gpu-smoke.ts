/**
 * `engine-gpu-smoke` (plan #68 C1 §5.1, R1): in the engine web image, for each engine e2e
 * project, prints the adapter headless Chromium offers and whether it renders: `lavapipe`, the
 * WebGL2 `RENDERER` (ANGLE on lavapipe, llvmpipe) and a cleared pixel read back; `swiftshader`,
 * the WebGPU adapter (Dawn's SwiftShader) and a cleared canvas screenshotted. Exit 1 when
 * lavapipe is not llvmpipe or does not render, or when SwiftShader does not render and
 * `e2e/engine-legs.json` does not make the WebGPU leg report-only.
 *
 * Usage (in the image): node scripts/engine-gpu-smoke.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { decodePng } from '../e2e/png.ts';
import { LAVAPIPE_ARGS, SWIFTSHADER_ARGS } from '../playwright.engine.config.ts';

export interface Smoke {
  readonly adapter: string;
  readonly renders: boolean;
}

async function page(args: readonly string[]) {
  const browser = await chromium.launch({ channel: 'chromium', args: [...args] });
  const p = await browser.newPage();
  // A secure origin for navigator.gpu, served by the route, not the network.
  await p.route('https://engine-smoke.invalid/', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>smoke</title>' }),
  );
  await p.goto('https://engine-smoke.invalid/');
  return { browser, p };
}

export async function webgl2(): Promise<Smoke> {
  const { browser, p } = await page(LAVAPIPE_ARGS);
  try {
    return await p.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl === null) return { adapter: 'none', renders: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const adapter = String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
      gl.clearColor(1, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { adapter, renders: px[0] === 255 && px[1] === 0 };
    });
  } finally {
    await browser.close();
  }
}

/** WebGPU: the adapter, then a canvas cleared to red, screenshotted (the page's compositing). */
export async function webgpu(): Promise<Smoke> {
  const { browser, p } = await page(SWIFTSHADER_ARGS);
  try {
    const adapter = await p.evaluate(async (): Promise<string> => {
      const gpu = (navigator as { gpu?: GPU }).gpu;
      const a = await gpu?.requestAdapter();
      if (gpu === undefined || a === null || a === undefined) return 'none';
      const i = a.info;
      const device = await a.requestDevice();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      canvas.id = 'smoke';
      document.body.append(canvas);
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (ctx === null) return 'no context';
      ctx.configure({ device, format: gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
      const enc = device.createCommandEncoder();
      enc
        .beginRenderPass({
          colorAttachments: [
            {
              view: ctx.getCurrentTexture().createView(),
              clearValue: { r: 1, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        .end();
      device.queue.submit([enc.finish()]);
      const name = [i.vendor, i.architecture, i.device, i.description].filter((x) => x).join(' | ');
      try {
        await device.queue.onSubmittedWorkDone();
      } catch (e) {
        return `${name} (onSubmittedWorkDone: ${e instanceof Error ? e.message : String(e)})`;
      }
      await new Promise((r) => requestAnimationFrame(r));
      return name;
    });
    if (adapter === 'none' || adapter === 'no context') return { adapter, renders: false };
    const shot = decodePng(await p.locator('#smoke').screenshot());
    const at = (shot.h >> 1) * shot.w * 4 + (shot.w >> 1) * 4;
    const renders = (shot.px[at] ?? 0) > 200 && (shot.px[at + 1] ?? 255) < 50;
    return { adapter, renders };
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const gl = await webgl2();
  const wg = await webgpu();
  console.log(`lavapipe: WebGL2 RENDERER: ${gl.adapter}; renders: ${String(gl.renders)}`);
  console.log(`swiftshader: WebGPU adapter: ${wg.adapter}; renders: ${String(wg.renders)}`);
  const legs = new URL('../e2e/engine-legs.json', import.meta.url);
  const report =
    existsSync(legs) &&
    (JSON.parse(readFileSync(legs, 'utf8')) as { webgpu?: string }).webgpu === 'report';
  if (report) console.log('WebGPU leg report-only (e2e/engine-legs.json)');
  const webgpuOk = /swiftshader/i.test(wg.adapter) && wg.renders;
  process.exitCode = /llvmpipe/i.test(gl.adapter) && gl.renders && (webgpuOk || report) ? 0 : 1;
}
