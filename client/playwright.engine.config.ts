/**
 * The engine specs (plan #68 C1 §5, §5.1): `e2e:mode-matrix`, `golden:engine-line`,
 * `e2e:engine-recovery` and the engine leg of `e2e:csp-violations`, in Chromium on the lavapipe
 * Vulkan ICD of the engine web image (`make engine-e2e`), against the e2e BFFs of the fault build.
 * Dawn (WebGPU) and ANGLE (WebGL2) both run on the system Vulkan loader, not SwiftShader.
 */
import { defineConfig, devices } from '@playwright/test';

const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: 'e2e',
  testMatch: [
    'engine-mode-matrix.spec.ts',
    'golden-engine-line.spec.ts',
    'engine-recovery.spec.ts',
    'csp-violations.spec.ts',
  ],
  grep: /mode-matrix|engine-line|engine-recovery|csp-violations \(engine\)/,
  retries: 0,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'engine',
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        channel: 'chromium',
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-vulkan=native',
            '--use-angle=vulkan',
            '--ignore-gpu-blocklist',
            '--disable-vulkan-surface',
          ],
        },
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
