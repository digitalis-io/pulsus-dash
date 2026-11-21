import { defineConfig, devices } from '@playwright/test';

const viewport = { width: 1440, height: 900 };
const ci = Boolean(process.env['CI']);
// `E2E_SERVER=preview` runs the suite on `vite preview` (no database); the BFF specs skip.
const preview = process.env['E2E_SERVER'] === 'preview';
// Golden baselines are written only by CI's Chromium under the `golden-update` label (T05-005).
const updateGoldens = process.env['PW_UPDATE_GOLDENS'] === '1';
// Chromium only: pixel goldens and benches are not compared across engines.
const chromiumOnly =
  /(golden-gallery|perf-chart-redraw|perf-cold-load|perf-inp-rooms|bff-headers|bff-http|dev-proxy)\.spec\.ts/;

// The servers of plan #59 §3.7: the stub-mode and http-mode BFF builds (`make e2e-build`), and
// the Vite dev server proxied to the http-mode BFF.
const bffServers = [
  {
    command: 'tools/e2e/serve.sh stub 4173',
    cwd: '..',
    url: 'http://localhost:4173/healthz',
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
  {
    command: 'tools/e2e/serve.sh http 4174',
    cwd: '..',
    url: 'http://localhost:4174/healthz',
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
  {
    command: 'npx --no-install vite --port 5174 --strictPort',
    cwd: '.',
    env: { VITE_API_MODE: 'http', PULSUS_DASH_DEV_BFF: 'http://localhost:4174' },
    url: 'http://localhost:5174',
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
];
const previewServer = {
  command: 'npm run build && npm run preview',
  url: 'http://localhost:4173',
  reuseExistingServer: !ci,
  timeout: 120_000,
};

export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  updateSnapshots: updateGoldens ? 'all' : 'none',
  expect: {
    toHaveScreenshot: {
      threshold: 0.1,
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  retries: ci ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport } },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport },
      testIgnore: chromiumOnly,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport },
      testIgnore: chromiumOnly,
    },
  ],
  webServer: preview ? previewServer : bffServers,
});
