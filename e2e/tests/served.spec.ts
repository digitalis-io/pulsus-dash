// The runtime served by the pulsus-dash binary under the production CSP and Trusted Types
// (T18-001..T18-005, T03-022; e2e:csp-violations) and the PRF-008 startup report (plan §4.6).
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { PRODUCTION_CSP, STATUS, recordViolations, waitStatus } from "./helpers";

const TRACES = path.join(__dirname, "..", "test-results", "traces");
const tierOf = (project: string) => (project === "webgpu" ? STATUS.T1 : STATUS.T2);

test("@webgl2 served_document_isolated_under_production_csp", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp).not.toBeNull();
  const h = resp!.headers();
  expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  expect(h["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(h["content-security-policy"]).toBe(PRODUCTION_CSP);
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await waitStatus(page, STATUS.T2);
});

test("@webgpu @webgl2 no_csp_violations_during_boot", async ({ page }, info) => {
  const v = await recordViolations(page);
  await page.goto("/");
  await waitStatus(page, tierOf(info.project.name));
  await page.waitForTimeout(500);
  expect(await v.events()).toEqual([]);
  expect(v.console).toEqual([]);
});

test("@webgl2 trusted_types_enforced", async ({ page }) => {
  await page.goto("/");
  await waitStatus(page, STATUS.T2);
  const r = await page.evaluate(() => {
    const kind = (f: () => unknown) => {
      try {
        f();
        return "no error";
      } catch (e) {
        return (e as Error).constructor.name;
      }
    };
    return {
      html: kind(() => {
        document.createElement("div").innerHTML = "<b>x</b>";
      }),
      worker: kind(() => new Worker("data:text/javascript,1")),
      policy: kind(() => (self as any).trustedTypes.createPolicy("other", {})),
    };
  });
  expect(r).toEqual({ html: "TypeError", worker: "TypeError", policy: "TypeError" });
});

test("@webgpu @webgl2 startup_time_reported", async ({ browser }, info) => {
  test.setTimeout(300_000);
  const want = tierOf(info.project.name);
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext({ baseURL: info.project.use.baseURL });
    const page = await ctx.newPage();
    await page.goto("/");
    await waitStatus(page, want, 60_000);
    const ms = await page.evaluate(() => performance.now());
    expect(ms).toBeLessThan(60_000);
    runs.push(Math.round(ms));
    await ctx.close();
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const p75 = sorted[Math.ceil(0.75 * sorted.length) - 1];
  fs.mkdirSync(TRACES, { recursive: true });
  fs.writeFileSync(
    path.join(TRACES, `startup-${info.project.name}.json`),
    JSON.stringify({ runs_ms: runs, p75_ms: p75 }),
  );
});

test("@webgl2 readyz_ready_without_pulsusdb", async ({ request }) => {
  const r = await request.get("/readyz");
  expect(r.status()).toBe(200);
  expect((await r.json()).status).toBe("ready");
});
