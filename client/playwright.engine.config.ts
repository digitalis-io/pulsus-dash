/**
 * The engine specs (plan #68 C1 §5, §5.1): `e2e:mode-matrix`, `golden:engine-line`,
 * `e2e:engine-recovery` and the engine leg of `e2e:csp-violations`, in the engine web image's
 * Chromium (`make engine-e2e`), against the e2e BFFs of the fault build. Two projects (R1: Dawn
 * lists no lavapipe adapter): `lavapipe` (WebGL2 through ANGLE on the pinned Mesa: the gated tier,
 * goldens included) and `swiftshader` (WebGPU on Dawn's CPU adapter: gated functionally, goldens
 * report-only). `e2e/engine-legs.json`, if present, makes the WebGPU leg report-only.
 */
import { defineConfig, devices } from '@playwright/test';

const viewport = { width: 1440, height: 900 };

export const LAVAPIPE_ARGS = [
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--use-vulkan=native',
  '--ignore-gpu-blocklist',
  '--disable-vulkan-surface',
] as const;
export const SWIFTSHADER_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--use-webgpu-adapter=swiftshader',
] as const;

export default defineConfig({
  testDir: 'e2e',
  testMatch: [
    'engine-mode-matrix.spec.ts',
    'golden-engine-line.spec.ts',
    'engine-recovery.spec.ts',
    'csp-violations.spec.ts',
  ],
  grep: /mode-matrix|line presence|engine-line|engine-recovery|csp-violations \(engine\)/,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['./e2e/engineLegsReporter.ts']],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport,
    trace: 'retain-on-failure',
  },
  projects: [
    // Gated: WebGL2 through ANGLE on the lavapipe Vulkan ICD (T05-004's Mesa pin).
    {
      name: 'lavapipe',
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        channel: 'chromium',
        launchOptions: { args: [...LAVAPIPE_ARGS] },
      },
    },
    // WebGPU on Dawn's SwiftShader adapter (R1: Dawn lists no lavapipe adapter): gated
    // functionally, its goldens report-only.
    {
      name: 'swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        channel: 'chromium',
        launchOptions: { args: [...SWIFTSHADER_ARGS] },
      },
    },
  ],
  webServer: [
    {
      command: 'tools/e2e/fake.sh 4190',
      cwd: '..',
      url: 'http://localhost:4190/__fake/requests',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'tools/e2e/serve.sh stub 4173',
      cwd: '..',
      url: 'http://localhost:4173/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
