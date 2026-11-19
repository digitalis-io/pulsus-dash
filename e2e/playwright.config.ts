// Playwright configuration for the browser runtime mode matrix (T03 §10, T05 §7.1 e2e:mode-matrix).
// Run through `cargo xtask ci e2e`, which builds the probe-enabled test artefacts into
// target/web-test first. Each project selects its tests by tag.
import { defineConfig } from "@playwright/test";

const swiftshaderWebGpu = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

const project = (name: string, port: number, args: string[]) => ({
  name,
  grep: new RegExp(`@${name}\\b`),
  use: { channel: "chromium", baseURL: `http://localhost:${port}`, launchOptions: { args } },
});

export default defineConfig({
  testDir: "./tests",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  webServer: [
    {
      command: "cargo xtask serve --root target/web-test --port 8787",
      port: 8787,
      reuseExistingServer: false,
      timeout: 600_000,
    },
    {
      command: "cargo xtask serve --root target/web-test --port 8788 --no-isolation",
      port: 8788,
      reuseExistingServer: false,
      timeout: 600_000,
    },
  ],
  projects: [
    project("webgpu", 8787, swiftshaderWebGpu),
    project("webgl2", 8787, [
      "--disable-blink-features=WebGPU",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ]),
    project("nogpu", 8787, [
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-blink-features=WebGPU",
    ]),
    project("noiso", 8788, swiftshaderWebGpu),
  ],
});
