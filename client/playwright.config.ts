import { defineConfig, devices } from '@playwright/test';

const viewport = { width: 1440, height: 900 };
const ci = Boolean(process.env['CI']);

export default defineConfig({
  testDir: 'e2e',
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
      testIgnore: /perf-cold-load\.spec\.ts/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport },
      testIgnore: /perf-cold-load\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
});
