// Playwright configuration for the browser runtime mode matrix (T03 §10, T05 §7.1 e2e:mode-matrix).
// Run through `cargo xtask ci e2e`, which builds the probe-enabled test artefacts into
// target/web-test first; port 8787 is the pulsus-dash binary (`cargo xtask dev up`) under the
// production CSP, 8788 a header-stripping deployment (T03-022). Each project selects its tests by
// tag. With DASH_E2E_DEVUP=1 only the `devup` project runs, against an already running
// `cargo xtask dev up --port 8789` (the xtask dev_up_flow test).
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

const devup = process.env.DASH_E2E_DEVUP === "1";

export default defineConfig({
  testDir: "./tests",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  webServer: devup
    ? undefined
    : [
        {
          command: "cargo xtask dev up --assets target/web-test --port 8787",
          port: 8787,
          reuseExistingServer: false,
          timeout: 900_000,
        },
        {
          command: "cargo xtask serve --root target/web-test --port 8788 --no-isolation",
          port: 8788,
          reuseExistingServer: false,
          timeout: 600_000,
        },
      ],
  projects: devup
    ? [project("devup", 8789, swiftshaderWebGpu)]
    : [
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
