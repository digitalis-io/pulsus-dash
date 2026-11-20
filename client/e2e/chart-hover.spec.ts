/** `e2e:chart-hover` (plan #58 §5, INT-033): the tooltip shows every series' value and label. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { pointerWindowStart } from '../src/charts/chartText.ts';
import { seriesName } from '../src/data/frames.ts';
import { GALLERY_SEED } from '../src/dev/gallery.ts';
import { LEVELS, synthLineValue } from '../src/dev/synth.ts';
import { formatTime, formatValue } from '../src/i18n/format.ts';
import {
  frame,
  GALLERY_FROM,
  GALLERY_TO,
  GALLERY_URL,
  galleryReady,
  open,
  plotOf,
  plotX,
  timeAt,
} from './helpers.ts';

const STEP = Math.floor((GALLERY_TO - GALLERY_FROM) / 1_440);

async function tooltipRows(f: Locator): Promise<[string, string][]> {
  return f
    .locator('[data-chart-tooltip] [data-row]')
    .evaluateAll((rows) =>
      rows.map((r) => [
        r.querySelector('[data-name]')?.textContent ?? '',
        r.querySelector('[data-value]')?.textContent ?? '',
      ]),
    );
}

/** Hovers near sample 720 at an integer page x; returns that x and the sample the engine snaps to. */
async function hoverSample(page: Page, f: Locator, yFrac = 0.5) {
  await f.scrollIntoViewIfNeeded();
  const plot = await plotOf(f);
  const box = await f.boundingBox();
  if (box === null) throw new Error('no box');
  const x = Math.round(plotX(box.x, plot, GALLERY_FROM + 720 * STEP, GALLERY_FROM, GALLERY_TO));
  const k = Math.round((timeAt(box.x, plot, x, GALLERY_FROM, GALLERY_TO) - GALLERY_FROM) / STEP);
  await page.mouse.move(x, box.y + plot.y + plot.height * yFrac);
  return { x, k, plot, box };
}

test.describe('e2e:chart-hover', () => {
  test('line-gaps: time, every series and its value', async ({ page }) => {
    await open(page, GALLERY_URL);
    await galleryReady(page);
    const f = frame(page, 'line-gaps');
    const { k } = await hoverSample(page, f);
    const t = GALLERY_FROM + k * STEP;
    const tip = f.locator('[data-chart-tooltip]');
    await expect(tip).toBeVisible();
    await expect(tip.locator('[data-time]')).toHaveText(formatTime(t, 'Europe/London'));
    await expect(tip.locator('[data-row]')).toHaveCount(3);
    const rows = [0, 1, 2].map((j) => {
      const labels = { __name__: 'queue_depth', pod: `pod-${String(j).padStart(3, '0')}` };
      return {
        name: seriesName(labels),
        value: synthLineValue(GALLERY_SEED + 2, j, t, 40, 15),
      };
    });
    // The tooltip order, computed here rather than with the client's sortedRows: value descending,
    // then name ascending.
    const sorted = [...rows].sort(
      (a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const want = sorted.map((r): [string, string] => [
      r.name,
      formatValue(r.value, { kind: 'none' }),
    ]);
    expect(await tooltipRows(f)).toEqual(want);
  });

  test('many series: the pointer row window reaches every series', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, GALLERY_URL);
    await galleryReady(page);
    const f = frame(page, 'line-50');
    const { x, plot, box } = await hoverSample(page, f, 0);
    const range = f.locator('[data-chart-tooltip] [data-range]');
    const top = Math.ceil(box.y + plot.y);
    const bottom = Math.floor(box.y + plot.y + plot.height);
    await page.mouse.move(x, top);
    await expect(range).toHaveText('Rows 1–20 of 50');
    const names = new Set<string>();
    for (let y = top; y <= bottom; y++) {
      await page.mouse.move(x, y);
      // Wait for the frame's hover at this height: the window the pointer position gives.
      const start = pointerWindowStart(50, y - box.y, plot);
      await expect(range).toHaveText(`Rows ${String(start + 1)}–${String(start + 20)} of 50`);
      for (const [n] of await tooltipRows(f)) names.add(n);
    }
    await expect(range).toHaveText('Rows 31–50 of 50');
    expect(names.size).toBe(50);

    const b = frame(page, 'bars');
    await b.scrollIntoViewIfNeeded();
    const bp = await plotOf(b);
    const bb = await b.boundingBox();
    if (bb === null) throw new Error('no bars box');
    const bx = plotX(bb.x, bp, GALLERY_FROM + 29.25 * 60_000, GALLERY_FROM, GALLERY_TO);
    for (let y = Math.ceil(bb.y + bp.y); y <= Math.floor(bb.y + bp.y + bp.height); y += 1) {
      await page.mouse.move(bx, y);
      await expect
        .poll(async () => (await tooltipRows(b)).map(([n]) => n).sort(), {
          message: `y ${String(y)}`,
        })
        .toEqual([...LEVELS].sort());
    }
  });
});
