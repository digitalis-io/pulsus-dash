import { defineConfig, devices } from '@playwright/test';

const viewport = { width: 1440, height: 900 };
const ci = Boolean(process.env['CI']);
// Golden baselines are written only by CI's Chromium under the `golden-update` label (T05-005).
const updateGoldens = process.env['PW_UPDATE_GOLDENS'] === '1';
// Chromium only: pixel goldens and benches are not compared across engines.
const chromiumOnly = /(golden-gallery|perf-chart-redraw|perf-cold-load)\.spec\.ts/;

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
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
});
