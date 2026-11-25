/**
 * `engine-gpu-smoke` (plan #68 C1 §5.1, risk R1): in the engine web image, prints the WebGPU
 * adapter and the WebGL2 `RENDERER` headless Chromium sees with the engine e2e flags
 * (playwright.engine.config.ts). Both must name lavapipe (llvmpipe): Dawn and ANGLE on the
 * system Vulkan loader, not SwiftShader. Exit 1 when either is missing or is not llvmpipe.
 *
 * Usage (in the image): node scripts/engine-gpu-smoke.ts
 */
import { chromium } from '@playwright/test';
import config from '../playwright.engine.config.ts';

const args = config.projects?.[0]?.use?.launchOptions?.args ?? [];

export async function smoke(): Promise<{ webgpu: string; webgl2: string }> {
  const browser = await chromium.launch({ args: [...args] });
  try {
    const page = await browser.newPage();
    // A secure origin for navigator.gpu, served by the route, not the network.
    await page.route('https://engine-smoke.invalid/', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>smoke</title>' }),
    );
    await page.goto('https://engine-smoke.invalid/');
    return await page.evaluate(async () => {
      const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      const adapter = (await gpu?.requestAdapter()) as
        | { info?: { vendor: string; architecture: string; device: string; description: string } }
        | null
        | undefined;
      const i = adapter?.info;
      const webgpu =
        i === undefined ? 'none' : [i.vendor, i.architecture, i.device, i.description].join(' | ');
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const webgl2 =
        gl === null || gl === undefined
          ? 'none'
          : String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
      return { webgpu, webgl2 };
    });
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const r = await smoke();
  console.log(`WebGPU adapter: ${r.webgpu}`);
  console.log(`WebGL2 RENDERER: ${r.webgl2}`);
  process.exitCode = /llvmpipe/i.test(r.webgpu) && /llvmpipe/i.test(r.webgl2) ? 0 : 1;
}
