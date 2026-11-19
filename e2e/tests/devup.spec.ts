// The documented default flow (`cargo xtask dev up`, acceptance): run by the xtask
// dev_up_flow itest with DASH_E2E_DEVUP=1 against http://localhost:8789.
import { expect, test } from "@playwright/test";
import { STATUS, expectRendersAndAnimates, recordViolations } from "./helpers";

test("@devup runtime_page_renders_from_dev_up", async ({ page }) => {
  const v = await recordViolations(page);
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await page.waitForFunction(
    ([t1, t2]) => [t1, t2].includes(document.documentElement.dataset.dashStatus ?? ""),
    [STATUS.T1, STATUS.T2],
    { timeout: 30_000 },
  );
  await expectRendersAndAnimates(page);
  expect(await v.events()).toEqual([]);
  expect(v.console).toEqual([]);
});
