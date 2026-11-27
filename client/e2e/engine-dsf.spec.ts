/**
 * `e2e:engine-dsf` (plan #68 D2 §5, E1–E6): range data reaches the MT engine as DSF, decoded on
 * the pool, and the line frame takes the chunk by reference. Project `lavapipe` (WebGL2 on the
 * pinned Mesa) against the http BFF over the PulsusDB fake (port 4174, as the engine leg of
 * `e2e:selection-sources`), on the fault build with `?probe=1`; E6 on `lavapipe-st`.
 *
 * A board's first query can run before the engine boots and so goes as JSON (R3); each case
 * refetches once the engine is up (`__dashProbeQueries.invalidateQueries()`), which asks for DSF.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { colour } from '../src/styles/tokens.ts';
import { HTTP_BFF } from './bff.ts';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';
import { compareImages, decodePng, engineModeOf } from './engine.ts';
import { fakeRequests } from './fake.ts';
import { boardUrl, panel, S_FROM, S_TO } from './inspectorBoards.ts';

const RANGE = '/api/dash/v1/query/promql/range';
const DSF = 'application/vnd.pulsus.dash-stream';
const ENGINE = '&engine=wasm&mode=t2&probe=1';
/** `max_payload` (`wire/schemas/limits.json`). */
const MAX_PAYLOAD = 64 << 20;

interface Decodes {
  begun: number;
  done: number;
  failed: number;
  retried: number;
  aborted: number;
  byRef: number;
}

declare global {
  interface Window {
    __dashProbe?: {
      decodes(): Decodes;
      chunks(): Promise<{ count: number; bytes: number }>;
      decoder(on: boolean): void;
    };
    __dashProbeQueries?: { invalidateQueries(): Promise<void>; clear(): void };
    __bodyReads: string[];
  }
}

const LINE: PanelInput[] = [
  { id: 'a', title: 'A', text: 'inspector_two', grid: [0, 0, 12, 8], vis: { kind: 'line' } },
];

test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

const only = (info: TestInfo, project: string): void => {
  test.skip(info.project.name !== project, `${project} project only`);
};

/** `Response.json`/`text`/`arrayBuffer` calls on main, by URL (installed before the page). */
async function spyBodyReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__bodyReads = [];
    for (const m of ['json', 'text', 'arrayBuffer', 'blob'] as const) {
      const orig = Reflect.get(Response.prototype, m) as (this: Response) => Promise<unknown>;
      Object.defineProperty(Response.prototype, m, {
        value: function (this: Response) {
          window.__bodyReads.push(`${m} ${this.url}`);
          return orig.call(this);
        },
      });
    }
  });
}

async function withLineBoard(
  page: Page,
  request: Parameters<typeof createBoard>[0],
  panels: PanelInput[],
  extra: string,
  body: (uid: string) => Promise<void>,
): Promise<void> {
  const uid = await createBoard(request, `engine dsf ${crypto.randomUUID()}`, panels);
  try {
    await page.goto(boardUrl(uid, S_FROM, S_TO, extra));
    await page.locator('html[data-shell-ready="true"]').waitFor();
    await body(uid);
  } finally {
    await deleteBoard(request, uid);
  }
}

/** The panel's line frame on the engine, ready. */
async function onEngine(page: Page, id: string): Promise<void> {
  await expect(panel(page, id).locator('[data-frame-ready="true"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(panel(page, id).locator('canvas:not([data-retired])')).toHaveAttribute(
    'data-engine',
    'wasm-webgl2',
  );
}

const decodes = (page: Page): Promise<Decodes> =>
  page.evaluate(() => {
    const p = window.__dashProbe;
    if (p === undefined) throw new Error('no probe');
    return p.decodes();
  });

/** Refetches every query (the engine is up now: range queries ask for DSF). */
async function refetch(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__dashProbeQueries?.invalidateQueries();
  });
}

/** The range requests from now on: their `Accept`, and their responses' `Content-Type`. */
function rangeTraffic(page: Page): { accept: string[]; type: string[] } {
  const t = { accept: [] as string[], type: [] as string[] };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === RANGE) t.accept.push(r.headers()['accept'] ?? '');
  });
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === RANGE) t.type.push(r.headers()['content-type'] ?? '');
  });
  return t;
}

const legend = (page: Page, id: string): Promise<string[]> =>
  panel(page, id).locator('[data-legend-item]').allInnerTexts();

/** A device-scale screenshot of the panel's live canvas, under the test's output. */
async function shot(page: Page, id: string, info: TestInfo, name: string): Promise<string> {
  const c = panel(page, id).locator('canvas:not([data-retired])');
  const path = info.outputPath(`${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await c.screenshot({ scale: 'device' }));
  return path;
}

/** Waits for the panel's frame to settle after a refetch (two drawn frames apart). */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 750)));
}

test.describe('e2e:engine-dsf', () => {
  test('e2e:engine-dsf E1 board line panel: DSF to the engine, by reference', async ({
    page,
    request,
  }, info) => {
    only(info, 'lavapipe');
    test.setTimeout(120_000);
    let reference: string[] = [];
    await withLineBoard(page, request, LINE, '&engine=canvas2d', async () => {
      await expect(panel(page, 'a').locator('[data-frame-ready="true"]')).toHaveCount(1);
      reference = await legend(page, 'a');
    });
    expect(reference.length).toBe(2);
    await spyBodyReads(page);
    await withLineBoard(page, request, LINE, ENGINE, async () => {
      await onEngine(page, 'a');
      const traffic = rangeTraffic(page);
      const before = await decodes(page);
      await page.evaluate(() => (window.__bodyReads = []));
      await refetch(page);
      await expect.poll(async () => (await decodes(page)).done - before.done).toBe(1);
      await settled(page);
      expect(traffic.accept).toEqual([`${DSF};v=1, application/json;q=0.1`]);
      expect(traffic.type).toEqual([`${DSF};v=1`]);
      const d = await decodes(page);
      expect(d.byRef - before.byRef).toBeGreaterThanOrEqual(1);
      expect(d.retried - before.retried).toBe(0);
      const reads = await page.evaluate(() => window.__bodyReads);
      expect(reads.filter((r) => r.includes(RANGE))).toEqual([]);
      expect(await legend(page, 'a')).toEqual(reference);
    });
  });

  test('e2e:engine-dsf E2 pixels: the DSF chunk draws as the values do', async ({
    page,
    request,
  }, info) => {
    only(info, 'lavapipe');
    test.setTimeout(120_000);
    await withLineBoard(page, request, LINE, ENGINE, async () => {
      await onEngine(page, 'a');
      const before = await decodes(page);
      await refetch(page);
      await expect.poll(async () => (await decodes(page)).byRef - before.byRef).toBeGreaterThan(0);
      await settled(page);
      const dsf = await shot(page, 'a', info, 'dsf');
      await page.evaluate(() => window.__dashProbe?.decoder(false));
      await refetch(page);
      await settled(page);
      const after = await decodes(page);
      const values = await shot(page, 'a', info, 'values');
      expect(after.done).toBe((await decodes(page)).done);
      const r = compareImages(dsf, values, { max: 0.001, tileMax: 0.05 });
      expect(r.code, r.out).toBe(0);
    });
  });

  test('e2e:engine-dsf E3 hover and selection on the DSF chunk', async ({
    page,
    request,
  }, info) => {
    only(info, 'lavapipe');
    test.setTimeout(120_000);
    await withLineBoard(page, request, LINE, ENGINE, async () => {
      await onEngine(page, 'a');
      const canvas = panel(page, 'a').locator('canvas:not([data-retired])');
      const box = await canvas.boundingBox();
      if (box === null) throw new Error('no canvas box');
      const hoverRows = async (): Promise<string> => {
        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
        const tip = panel(page, 'a').locator('[data-chart-tooltip]');
        await expect(tip).toBeVisible();
        return tip.innerText();
      };
      // The JSON run (the decoder disabled), then the DSF run.
      await page.evaluate(() => window.__dashProbe?.decoder(false));
      await refetch(page);
      await settled(page);
      const json = await hoverRows();
      await page.evaluate(() => window.__dashProbe?.decoder(true));
      const before = await decodes(page);
      await refetch(page);
      await expect.poll(async () => (await decodes(page)).byRef - before.byRef).toBeGreaterThan(0);
      await settled(page);
      expect(await hoverRows()).toBe(json);
      await page.mouse.move(0, 0);
      // C2c2's S1 check: the legend's Select highlights the key on the next frame.
      await settled(page);
      const none = await canvas.screenshot();
      const toggle = panel(page, 'a').getByRole('button', {
        name: /^Select inspector_two\{series="k1"\}/,
      });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      const focus = [1, 3, 5].map((i) => parseInt(colour.dark.focus.slice(i, i + 2), 16));
      await expect
        .poll(
          async () => {
            const s = await canvas.screenshot();
            if (s.equals(none)) return 'unchanged';
            const img = decodePng(s);
            let n = 0;
            for (let i = 0; i < img.px.length; i += 4) {
              const d = Math.max(
                ...[0, 1, 2].map((c) => Math.abs((img.px[i + c] ?? 0) - (focus[c] ?? 0))),
              );
              if (d <= 8) n++;
            }
            return n >= 50 ? 'focused' : `focus pixels ${String(n)}`;
          },
          { timeout: 10_000 },
        )
        .toBe('focused');
    });
  });

  test('e2e:engine-dsf E4 supersede and release', async ({ page, request }, info) => {
    only(info, 'lavapipe');
    test.setTimeout(150_000);
    await withLineBoard(page, request, LINE, ENGINE, async (uid) => {
      await onEngine(page, 'a');
      const before = await decodes(page);
      // Five window changes in a row (in-app navigation, a minute apart).
      for (let k = 1; k <= 5; k++) {
        const url = boardUrl(uid, S_FROM - k * 60_000, S_TO - k * 60_000, ENGINE);
        await page.evaluate((u) => {
          const state: unknown = history.state;
          history.pushState(state, '', u);
          dispatchEvent(new PopStateEvent('popstate', { state }));
        }, url);
      }
      // The last window's result is drawn; every decode begun has ended (done, failed or aborted).
      await expect
        .poll(async () => {
          const d = await decodes(page);
          return d.begun > before.begun && d.done + d.failed + d.aborted === d.begun;
        })
        .toBe(true);
      const fake = await fakeRequests(request, { query: 'inspector_two' });
      const last = fake.filter((r) => r.start === String((S_FROM - 5 * 60_000) / 1000));
      expect(last.length).toBeGreaterThanOrEqual(1);
      await expect(panel(page, 'a').locator('[data-frame-ready="true"]')).toHaveCount(1);
      // The query cache dropped and collected: the table keeps only the frames' own chunks.
      const cdp = await page.context().newCDPSession(page);
      await page.evaluate(() => window.__dashProbeQueries?.clear());
      await expect
        .poll(
          async () => {
            await cdp.send('HeapProfiler.collectGarbage');
            await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
            return (await page.evaluate(() => window.__dashProbe?.chunks()))?.count ?? -1;
          },
          { timeout: 30_000 },
        )
        .toBeLessThanOrEqual(1);
    });
  });

  test('e2e:engine-dsf E5 failure and limit', async ({ page, request }, info) => {
    only(info, 'lavapipe');
    test.setTimeout(150_000);
    const CUT: PanelInput[] = [
      { id: 'c', title: 'C', text: 'dsf_cut', grid: [0, 0, 12, 8], vis: { kind: 'line' } },
    ];
    const errorText = (id: string) => panel(page, id).locator('[role="alert"]').first();
    // The JSON run's error state.
    let jsonState = false;
    await withLineBoard(page, request, CUT, '&engine=canvas2d', async () => {
      await expect(errorText('c')).toBeVisible({ timeout: 30_000 });
      jsonState = true;
    });
    expect(jsonState).toBe(true);
    await withLineBoard(page, request, CUT, ENGINE, async () => {
      await page.waitForFunction(() => document.documentElement.dataset['dashStatus'] === '2');
      const before = await decodes(page);
      await refetch(page);
      await expect.poll(async () => (await decodes(page)).failed - before.failed).toBe(1);
      await expect(errorText('c')).toBeVisible();
      await expect(errorText('c')).toContainText('internal error');
      expect((await decodes(page)).retried - before.retried).toBe(0);
    });
    // Over a B3 limit: the DSF body is refused and retried once as JSON, which draws all series.
    await page.route(`**${RANGE}**`, async (route) => {
      const accept = route.request().headers()['accept'] ?? '';
      if (!accept.includes(DSF)) {
        await route.continue();
        return;
      }
      const h = Buffer.alloc(64);
      h[0] = 1;
      h[1] = 1;
      h.writeUInt32LE(1, 4);
      h.writeUInt32LE(MAX_PAYLOAD + 8, 8);
      await route.fulfill({ status: 200, headers: { 'Content-Type': `${DSF};v=1` }, body: h });
    });
    await withLineBoard(page, request, LINE, ENGINE, async () => {
      await onEngine(page, 'a');
      const before = await decodes(page);
      await refetch(page);
      await expect.poll(async () => (await decodes(page)).retried - before.retried).toBe(1);
      await settled(page);
      expect(await legend(page, 'a')).toHaveLength(2);
      await expect(panel(page, 'a').locator('[data-frame-ready="true"]')).toHaveCount(1);
    });
  });

  test('e2e:engine-dsf E6 ST stays JSON', async ({ page, request }, info) => {
    test.skip(engineModeOf(info) !== 'st', 'the lavapipe-st project only');
    test.setTimeout(120_000);
    await withLineBoard(page, request, LINE, '&engine=wasm&mode=st&probe=1', async () => {
      await onEngine(page, 'a');
      await expect(page.locator('html')).toHaveAttribute('data-dash-mode', 'st');
      const traffic = rangeTraffic(page);
      await refetch(page);
      await expect.poll(() => traffic.type.length).toBeGreaterThanOrEqual(1);
      expect(traffic.accept.some((a) => a.includes(DSF))).toBe(false);
      expect(traffic.type.every((t) => t.startsWith('application/json'))).toBe(true);
      await settled(page);
      expect(await legend(page, 'a')).toHaveLength(2);
    });
  });
});
