/**
 * The engine specs (plan #68 C1 §5, §5.1): `e2e:mode-matrix`, `golden:engine-line`,
 * `e2e:engine-recovery` and the engine leg of `e2e:csp-violations`, in the engine web image's
 * Chromium (`make engine-e2e`), against the e2e BFFs of the fault build. Two projects (R1: Dawn
 * lists no lavapipe adapter): `lavapipe` (WebGL2 through ANGLE on the pinned Mesa: the gated tier,
 * goldens included) and `swiftshader` (WebGPU on Dawn's CPU adapter: gated functionally, goldens
 * report-only). `e2e/engine-legs.json`, if present, makes the WebGPU leg report-only. A third
 * project, `probe` (plan #68 C2a1 §3.5), runs `e2e:shim-fuzz` alone on lavapipe against the probe
 * build's BFF (`make e2e-build-probe`, port 4175); every other spec stays on the fault build.
 * `e2e:engine-camera` (plan #68 C2a2) runs on `lavapipe` (gated) and `swiftshader` (report-only
 * with the WebGPU leg) against the fault build with `?probe=1`; `bench:shim-input-cost` runs with
 * `e2e:shim-fuzz` in `probe`, report-only. `e2e:engine-layer` (plan #68 C2c1) runs as
 * `e2e:engine-camera` does. The default legs of `e2e:mode-matrix` (plan #256 §5) use three more
 * servers: the unflagged release BFF (`make e2e-build-release`, port 4176), `vite preview` of
 * `dist-release-stub` with its computed manifest (4177) and the dev server (5175).
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
    'engine-shim-fuzz.spec.ts',
    'engine-camera.spec.ts',
    'engine-hover.spec.ts',
    'engine-layer.spec.ts',
  ],
  grep: /mode-matrix|line presence|engine-line|engine-recovery|csp-violations \(engine\)|e2e:shim-fuzz|bench:shim-input-cost|e2e:engine-camera|e2e:engine-hover|e2e:engine-layer/,
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
      testIgnore: 'engine-shim-fuzz.spec.ts',
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
      testIgnore: 'engine-shim-fuzz.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        channel: 'chromium',
        launchOptions: { args: [...SWIFTSHADER_ARGS] },
      },
    },
    // The probe build (plan #68 C2a1 §3.5): `e2e:shim-fuzz` and `e2e:engine-hover` H1b, on the
    // gated tier.
    {
      name: 'probe',
      testMatch: ['engine-shim-fuzz.spec.ts', 'engine-hover.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        baseURL: 'http://localhost:4175',
        channel: 'chromium',
        launchOptions: { args: [...LAVAPIPE_ARGS] },
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
    {
      command: 'tools/e2e/serve.sh probe 4175',
      cwd: '..',
      url: 'http://localhost:4175/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'tools/e2e/serve.sh release 4176',
      cwd: '..',
      url: 'http://localhost:4176/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx --no-install vite preview --outDir dist-release-stub --port 4177 --strictPort',
      cwd: '.',
      url: 'http://localhost:4177',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx --no-install vite --port 5175 --strictPort',
      cwd: '.',
      env: { VITE_API_MODE: 'stub' },
      url: 'http://localhost:5175',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
