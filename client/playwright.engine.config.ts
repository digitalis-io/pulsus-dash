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
 * `e2e:engine-selection` (plan #68 C2c2) runs as `e2e:engine-camera` does, its S11 in `probe`; the
 * engine leg of `e2e:selection-sources` (`inspector.spec.ts`) runs on `lavapipe` against the
 * http-mode BFF (port 4174). The frame benches (plan #68 C2d1), `bench:frame-gallery` and
 * `bench:frame-line-1e8`, run in project `bench` (lavapipe, the probe build, one worker), which
 * exists only with `ENGINE_BENCH=1` (`make engine-bench`), so `make engine-e2e` never runs them;
 * the bench then starts only the fake and the probe BFF.
 */
import { defineConfig, devices } from '@playwright/test';
import { ENGINE_ONLY_SPECS, ENGINE_SHARED_SPECS } from './config/engineSpecs.ts';

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

/**
 * The cases of project `lavapipe-st` (plan #68 C2d2 §5): E1, E7, H1, H3, L1, L2, S1, S3, the
 * `golden:engine-line` pages and the 10⁴-op `e2e:shim-fuzz`.
 */
export const ST_LEGS =
  /e2e:engine-camera E[17] |e2e:engine-hover H[13] |e2e:engine-layer L[12] |e2e:engine-selection S[13] |golden:engine-line|e2e:shim-fuzz 10⁴ ops/;

/** `make engine-bench` (plan #68 C2d1 §2): only project `bench`, report-only. */
const BENCH = process.env['ENGINE_BENCH'] === '1';

export default defineConfig({
  testDir: 'e2e',
  // config/engineSpecs.ts (plan #263): the engine-only specs and the shared ones.
  testMatch: [...ENGINE_ONLY_SPECS, ...ENGINE_SHARED_SPECS],
  grep: /mode-matrix|line presence|engine-line|engine-recovery|csp-violations \(engine\)|e2e:shim-fuzz|bench:shim-input-cost|e2e:engine-camera|e2e:engine-hover|e2e:engine-layer|e2e:engine-selection|selection-sources \(engine\)/,
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
    // The single-thread engine (plan #68 C2d2 §5 ST legs): lavapipe with `&mode=st` from the
    // project metadata (`e2e/engine.ts` tierOf), on the listed cases; `e2e:shim-fuzz` runs against
    // the probe BFF's absolute URL.
    {
      name: 'lavapipe-st',
      metadata: { tier: 'lavapipe', engineMode: 'st' },
      testMatch: [
        'engine-camera.spec.ts',
        'engine-hover.spec.ts',
        'engine-layer.spec.ts',
        'engine-selection.spec.ts',
        'golden-engine-line.spec.ts',
        'engine-shim-fuzz.spec.ts',
      ],
      grep: ST_LEGS,
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        channel: 'chromium',
        launchOptions: { args: [...LAVAPIPE_ARGS] },
      },
    },
    // The probe build (plan #68 C2a1 §3.5): `e2e:shim-fuzz` and `e2e:engine-hover` H1b, on the
    // gated tier.
    {
      name: 'probe',
      testMatch: ['engine-shim-fuzz.spec.ts', 'engine-hover.spec.ts', 'engine-selection.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        baseURL: 'http://localhost:4175',
        channel: 'chromium',
        launchOptions: { args: [...LAVAPIPE_ARGS] },
      },
    },
    // The frame benches (plan #68 C2d1), report-only: only with ENGINE_BENCH=1.
    ...(BENCH
      ? [
          {
            name: 'bench',
            testMatch: ['bench-frame-gallery.spec.ts', 'bench-frame-line-1e8.spec.ts'],
            grep: /bench:frame-gallery|bench:frame-line-1e8/,
            workers: 1,
            use: {
              ...devices['Desktop Chrome'],
              viewport,
              baseURL: 'http://localhost:4175',
              channel: 'chromium',
              launchOptions: { args: [...LAVAPIPE_ARGS] },
            },
          },
        ]
      : []),
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
      command: 'tools/e2e/serve.sh http 4174',
      cwd: '..',
      url: 'http://localhost:4174/healthz',
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
    // The bench needs only the fake and the probe BFF.
  ].filter((w) => !BENCH || /fake\.sh|serve\.sh probe/.test(w.command)),
});
