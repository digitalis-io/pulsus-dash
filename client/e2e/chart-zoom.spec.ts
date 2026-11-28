/**
 * `e2e:chart-zoom` (plan #93 §5.2, Appendix A §A.9; INT-001, INT-002, INT-006, INT-007, INT-008,
 * INT-025): `Ctrl`+wheel zoom anchored at the pointer, a plain wheel left to the page with the zoom
 * hint, the page-scroll latch, pinch,
 * value-axis zoom and its reset, drag to pan, the context menu on the plot, axis drags, a board's
 * shared window, and a plot that does not move under the pointer through a commit and a refetch.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { brushSnapUnit } from '../src/engine/canvas2d/columns.ts';
import { mulberry32 } from '../src/test/random.ts';
import {
  frame,
  GALLERY,
  GALLERY_FROM,
  GALLERY_TO,
  GALLERY_URL,
  galleryReady,
  open,
  plotOf,
  plotX,
  searchOf,
  T,
  timeAt,
  type Plot,
} from './helpers.ts';

const HOUR = 3_600_000;

interface Box {
  x: number;
  y: number;
}

async function boxOf(f: Locator): Promise<Box> {
  const b = await f.boundingBox();
  if (b === null) throw new Error('frame has no box');
  return b;
}

/** The URL window in ms. */
function urlWindow(page: Page): { from: number; to: number } {
  const s = searchOf(page);
  return { from: Date.parse(s['from'] ?? ''), to: Date.parse(s['to'] ?? '') };
}

async function waitUrlChange(page: Page, before: string): Promise<void> {
  await expect.poll(() => page.url()).not.toBe(before);
}

const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

/** Waits until a (possibly smooth) page scroll has stopped. */
async function settled(page: Page): Promise<void> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const y = await scrollY(page);
        const same = y === last;
        last = y;
        return same;
      },
      { intervals: [100] },
    )
    .toBe(true);
}

/** "Pinned": the canvas label names the fixed value axis. */
async function pinned(f: Locator): Promise<boolean> {
  return ((await f.locator('canvas').getAttribute('aria-label')) ?? '').includes('Y axis fixed at');
}

/** Page point at fractions of the plot. */
function point(box: Box, plot: Plot, fx: number, fy = 0.5): { x: number; y: number } {
  return {
    x: Math.round(box.x + plot.x + fx * plot.width),
    y: Math.round(box.y + plot.y + fy * plot.height),
  };
}

interface WheelSeen {
  prevented: boolean;
  t: number;
  deltaY: number;
  /** The event target's tag: `CANVAS` over a chart. */
  target: string;
}

/** Records every wheel's `defaultPrevented`, `timeStamp` and `deltaY` on `window`, after the page's own listeners. */
function recordWheels(): void {
  const seen: WheelSeen[] = [];
  Object.assign(window, { __wheels: seen });
  window.addEventListener(
    'wheel',
    (e) => {
      seen.push({
        prevented: e.defaultPrevented,
        t: e.timeStamp,
        deltaY: e.deltaY,
        target: e.target instanceof Element ? e.target.tagName : '',
      });
    },
    { passive: true },
  );
}

const wheelLog = (page: Page): Promise<WheelSeen[]> =>
  page.evaluate(() => (window as unknown as { __wheels: WheelSeen[] }).__wheels.slice());

const wheels = async (page: Page): Promise<boolean[]> =>
  (await wheelLog(page)).map((w) => w.prevented);

/** A wheel with `Control` held: a time chart zooms only with the modifier (§4.1). */
async function zoomWheel(page: Page, dx: number, dy: number): Promise<void> {
  await page.keyboard.down('Control');
  await page.mouse.wheel(dx, dy);
  await page.keyboard.up('Control');
}

async function gallery(page: Page, id = 'line-1') {
  await open(page, GALLERY_URL);
  await galleryReady(page);
  const f = frame(page, id);
  // Charts below the fold are brought to the middle of the viewport first.
  if (id !== 'line-1') await centre(f);
  const plot = await plotOf(f);
  return { f, plot, box: await boxOf(f) };
}

/** Scrolls `f` to the middle of the viewport (no wheel event: the scroll latch is untouched). */
async function centre(f: Locator): Promise<void> {
  await f.evaluate((e) => {
    e.scrollIntoView({ block: 'center' });
  });
}

test('Z1: wheel zoom keeps the time under the pointer and is one history entry', async ({
  page,
}) => {
  await page.addInitScript(recordWheels);
  const { plot, box } = await gallery(page);
  const p = point(box, plot, 0.3);
  const ta = timeAt(box.x, plot, p.x, GALLERY_FROM, GALLERY_TO);
  const before = page.url();
  const entries0 = await page.evaluate(() => history.length);
  await page.mouse.move(p.x, p.y);
  const rnd = mulberry32(93);
  await page.keyboard.down('Control');
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, Math.round((rnd() * 2 - 1) * 200));
    await page.waitForTimeout(20);
  }
  await page.keyboard.up('Control');
  await waitUrlChange(page, before);
  // Past the idle commit of the last wheel.
  await page.waitForTimeout(450);
  const w = urlWindow(page);
  expect(w.to - w.from).not.toBe(HOUR);
  expect(Math.abs(plotX(box.x, plot, ta, w.from, w.to) - p.x)).toBeLessThan(1);
  // One gesture, one entry. A loaded runner can deliver two wheels more than the 300 ms idle
  // apart; the gesture is then legitimately split, and Back walks each entry it made.
  const log = await wheelLog(page);
  const gaps = log.slice(1).map((x, i) => x.t - (log[i]?.t ?? x.t));
  const pushes = (await page.evaluate(() => history.length)) - entries0;
  if (Math.max(...gaps) < 250) expect(pushes).toBe(1);
  expect(pushes).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < pushes; i++) await page.goBack();
  await expect
    .poll(() => searchOf(page))
    .toMatchObject({
      from: '2026-11-19T12:00:00.000Z',
      to: '2026-11-19T13:00:00.000Z',
    });
});

test('Z2: the wheel scrolls the page off the plot and zooms over it', async ({ page }) => {
  await page.addInitScript(recordWheels);
  const { f } = await gallery(page);
  const url = page.url();
  const y0 = await scrollY(page);
  const intro = page.locator('p').filter({ hasText: /seed/i }).first();
  const ib = await intro.boundingBox();
  if (ib === null) throw new Error('no intro');
  await page.mouse.move(ib.x + 20, ib.y + ib.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(y0);
  expect(page.url()).toBe(url);
  // Over line-1's value-axis band.
  await settled(page);
  await centre(f);
  const y1 = await scrollY(page);
  const plot = await plotOf(f);
  let box = await boxOf(f);
  await page.mouse.move(box.x + plot.x / 2, box.y + plot.y + plot.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(y1);
  expect(page.url()).toBe(url);
  // Past the 300 ms latch that the band wheel refreshed: the plot zooms.
  await settled(page);
  await page.waitForTimeout(400);
  await centre(f);
  const y2 = await scrollY(page);
  box = await boxOf(f);
  const p = point(box, plot, 0.5);
  await page.mouse.move(p.x, p.y);
  await zoomWheel(page, 0, -300);
  await waitUrlChange(page, url);
  expect(await scrollY(page)).toBe(y2);
  expect(await wheels(page)).toEqual([false, false, true]);
});

test('Z2b: a plain wheel over the plot scrolls the page, never zooms, and shows the hint', async ({
  page,
}) => {
  await page.addInitScript(recordWheels);
  const { f, plot } = await gallery(page);
  const url = page.url();
  await centre(f);
  await settled(page);
  await page.waitForTimeout(400);
  const y0 = await scrollY(page);
  const box = await boxOf(f);
  const p = point(box, plot, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(y0);
  await expect(f.locator('[data-wheel-hint]')).toHaveAttribute('data-visible', 'true');
  await expect(f.locator('[data-wheel-hint]')).toHaveText(/^Hold (Ctrl|⌘) to zoom$/);
  // Past the wheel-idle commit: no window change.
  await page.waitForTimeout(450);
  expect(page.url()).toBe(url);
  expect(await wheels(page)).toEqual([false]);
  await expect(f.locator('[data-wheel-hint]')).toHaveAttribute('data-visible', 'false');
});

test('Z3: a scroll in progress keeps scrolling over a plot', async ({ page }) => {
  await page.addInitScript(recordWheels);
  // The two wheels must reach the page within the latch; a loaded runner that delivers them
  // further apart makes the attempt inconclusive, and it is repeated on a fresh page.
  let gap = Infinity;
  for (let attempt = 0; attempt < 5 && !(gap < 250); attempt++) {
    const { f, plot } = await gallery(page);
    // A repeated attempt reopens the page, and the browser may restore its scroll position.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    const url = page.url();
    const y0 = await scrollY(page);
    const intro = page.locator('p').filter({ hasText: /seed/i }).first();
    const ib = await intro.boundingBox();
    if (ib === null) throw new Error('no intro');
    // The plot's middle once the page has scrolled by up to the 60 px of the first wheel.
    const box = await boxOf(f);
    const p = point(box, plot, 0.5);
    await page.mouse.move(ib.x + 20, ib.y + ib.height / 2);
    await page.mouse.wheel(0, 60);
    await page.mouse.move(p.x, p.y - 60);
    await page.mouse.wheel(0, 60);
    const log = await wheelLog(page);
    gap = (log[1]?.t ?? Infinity) - (log[0]?.t ?? 0);
    if (!(gap < 250)) continue;
    // The second wheel reached the chart and was left to the page, or the browser kept it on the
    // first wheel's target (Firefox's wheel transaction does that itself).
    expect(log[0]?.target).not.toBe('CANVAS');
    expect([log[0]?.target, 'CANVAS']).toContain(log[1]?.target);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(y0);
    await page.waitForTimeout(400);
    expect(page.url()).toBe(url);
    expect(await wheels(page)).toEqual([false, false]);
    const b2 = await boxOf(f);
    const p2 = point(b2, plot, 0.5);
    await page.mouse.move(p2.x, p2.y);
    await zoomWheel(page, 0, -100);
    await waitUrlChange(page, url);
    expect(await wheels(page)).toEqual([false, false, true]);
  }
  expect(gap).toBeLessThan(250);
});

test('Z4: a pinch and Ctrl+wheel zoom time; the page never zooms', async ({ page }) => {
  await page.addInitScript(recordWheels);
  const { f, plot, box } = await gallery(page);
  const view = () =>
    page.evaluate(() => ({ scale: window.visualViewport?.scale ?? 1, dpr: devicePixelRatio }));
  const v0 = await view();
  const p = point(box, plot, 0.4);
  await page.mouse.move(p.x, p.y);
  let before = page.url();
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -2.5);
  await page.keyboard.up('Control');
  await waitUrlChange(page, before);
  const w1 = urlWindow(page);
  expect(w1.to - w1.from).toBeLessThan(HOUR);
  // A pinch arrives with fractional steps and zooms time only (WebKit's whole steps too).
  expect(await pinned(f)).toBe(false);
  expect(await view()).toEqual({ scale: 1, dpr: v0.dpr });
  before = page.url();
  await zoomWheel(page, 0, -100);
  await waitUrlChange(page, before);
  expect(await pinned(f)).toBe(false);
  expect(await view()).toEqual({ scale: 1, dpr: v0.dpr });
});

test('Z5: Ctrl+Shift+wheel pins the value axis; Reset Y axis returns it to auto', async ({
  page,
}) => {
  const { f, plot, box } = await gallery(page);
  const p = point(box, plot, 0.4);
  await page.mouse.move(p.x, p.y);
  const url = page.url();
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  const reset = f.getByRole('button', { name: /^Reset Y axis: / });
  await expect(reset).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await pinned(f)).toBe(true);
  await zoomWheel(page, 0, -200);
  await waitUrlChange(page, url);
  expect(await pinned(f)).toBe(true);
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(reset).toBeHidden();
  await expect.poll(() => pinned(f)).toBe(false);
});

test('Z6: a left drag pans the window with the pointer', async ({ page }) => {
  const { plot, box } = await gallery(page);
  const p = point(box, plot, 0.4);
  const url = page.url();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 200, p.y, { steps: 10 });
  await page.mouse.up();
  await waitUrlChange(page, url);
  const w = urlWindow(page);
  expect(w.to - w.from).toBe(HOUR);
  expect(Math.abs(w.from - (GALLERY_FROM - (200 / plot.width) * HOUR))).toBeLessThanOrEqual(
    HOUR / plot.width,
  );
});

test('Z7: right drag brushes; no browser menu on the plot, the menu elsewhere', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: boolean[] = [];
    Object.assign(window, { __menus: seen });
    window.addEventListener('contextmenu', (e) => {
      seen.push(e.defaultPrevented);
    });
  });
  const { f, plot, box } = await gallery(page);
  const t = (x: number): number => timeAt(box.x, plot, x, GALLERY_FROM, GALLERY_TO);
  const lo = GALLERY_FROM + 20 * 60_000;
  const hi = GALLERY_FROM + 25 * 60_000;
  const u = brushSnapUnit((GALLERY_TO - GALLERY_FROM) / plot.width);
  let x1 = Math.floor(box.x + plot.x);
  while (t(x1) < lo + 0.1 * u) x1 += 1;
  let x2 = Math.ceil(box.x + plot.x + plot.width);
  while (t(x2) > hi - 0.1 * u) x2 -= 1;
  const y = box.y + plot.y + plot.height / 2;
  await page.mouse.move(x1, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x2, y, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await expect
    .poll(() => searchOf(page))
    .toMatchObject({ from: '2026-11-19T12:20:00.000Z', to: '2026-11-19T12:25:00.000Z' });
  const b2 = await boxOf(f);
  const c = point(b2, plot, 0.5);
  await page.mouse.click(c.x, c.y, { button: 'right' });
  await page.mouse.click(b2.x + plot.x / 2, c.y, { button: 'right' });
  await page.keyboard.press('Escape');
  const menus = () =>
    page.evaluate(() => (window as unknown as { __menus: boolean[] }).__menus.slice());
  await expect.poll(menus).toEqual([true, true, false]);
  expect(searchOf(page)).toMatchObject({
    from: '2026-11-19T12:20:00.000Z',
    to: '2026-11-19T12:25:00.000Z',
  });
});

test('Z8: axis drags pan each axis; double-click on the value axis fits it', async ({ page }) => {
  const { f, plot, box } = await gallery(page);
  let url = page.url();
  const below = box.y + plot.y + plot.height + 8;
  const xa = Math.round(box.x + plot.x + plot.width / 2);
  await page.mouse.move(xa, below);
  await page.mouse.down();
  await page.mouse.move(xa - 150, below, { steps: 10 });
  await page.mouse.up();
  await waitUrlChange(page, url);
  expect(urlWindow(page).from).toBeGreaterThan(GALLERY_FROM);
  url = page.url();
  const left = Math.round(box.x + plot.x / 2);
  const ya = Math.round(box.y + plot.y + plot.height / 2);
  await page.mouse.move(left, ya);
  await page.mouse.down();
  await page.mouse.move(left, ya + 40, { steps: 10 });
  await page.mouse.up();
  await expect(f.getByRole('button', { name: /^Reset Y axis: / })).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await pinned(f)).toBe(true);
  await page.mouse.dblclick(left, ya);
  await expect(f.getByRole('button', { name: /^Reset Y axis: / })).toBeHidden();
  await expect.poll(() => pinned(f)).toBe(false);
});

test('Z9: on a board every panel follows a commit; the value pin stays on its chart', async ({
  page,
}) => {
  // b-1 on a tall viewport, so every panel is on screen and queries (T07-012): a line, a stat and a
  // heatmap; the stat has no crosshair (plan #64: b-3's panels need variables or LogQL).
  await page.setViewportSize({ width: 1440, height: 1600 });
  await open(page, '/t/demo/board/b-1');
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(3);
  const sliders = page.getByRole('slider', { name: /^Crosshair: / });
  await expect(sliders).toHaveCount(2);
  const ranges = () =>
    sliders.evaluateAll((els) =>
      els.map((e) => [
        Number(e.getAttribute('aria-valuemin')),
        Number(e.getAttribute('aria-valuemax')),
      ]),
    );
  const r0 = await ranges();
  const frameOf = (title: string) =>
    page.locator('[data-chart-frame]', {
      has: page.getByRole('slider', { name: `Crosshair: ${title}`, exact: true }),
    });
  const p99 = frameOf('Request rate');
  const plot = await plotOf(p99);
  const box = await boxOf(p99);
  const p = point(box, plot, 0.5);
  await page.mouse.move(p.x, p.y);
  let url = page.url();
  await zoomWheel(page, 0, -200);
  await waitUrlChange(page, url);
  await expect
    .poll(async () => {
      const w = urlWindow(page);
      return (await ranges()).every(([a, b]) => a === w.from && b === w.to);
    })
    .toBe(true);
  url = page.url();
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await expect(p99.getByRole('button', { name: 'Reset Y axis: Request rate' })).toBeVisible();
  expect(await pinned(p99)).toBe(true);
  expect(await pinned(frameOf('Request latency'))).toBe(false);
  expect(page.url()).toBe(url);
  await page.goBack();
  await expect.poll(ranges).toEqual(r0);
});

test('Z10: the plot keeps its place through the commit and the refetch', async ({ page }) => {
  const { f, plot, box } = await gallery(page, 'bars');
  const rect = () => f.getAttribute('data-plot');
  const r0 = await rect();
  const p = point(box, plot, 0.2);
  await page.mouse.move(p.x, p.y);
  const url = page.url();
  const sliderOf = f.getByRole('slider');
  let ta = 0;
  for (let i = 0; i < 5; i++) {
    const vmin = Number(await sliderOf.getAttribute('aria-valuemin'));
    const vmax = Number(await sliderOf.getAttribute('aria-valuemax'));
    ta = timeAt(box.x, plot, p.x, vmin, vmax);
    await zoomWheel(page, 0, -300);
    await expect.poll(() => sliderOf.getAttribute('aria-valuemin')).not.toBe(String(vmin));
    expect(await rect()).toBe(r0);
  }
  await waitUrlChange(page, url);
  // Past the idle commit of the last wheel.
  await page.waitForTimeout(450);
  await expect(f).toHaveAttribute('data-frame-ready', 'true');
  expect(await rect()).toBe(r0);
  const w = urlWindow(page);
  await expect.poll(() => sliderOf.getAttribute('aria-valuemin')).toBe(String(w.from));
  expect(await rect()).toBe(r0);
  expect(Math.abs(plotX(box.x, plot, ta, w.from, w.to) - p.x)).toBeLessThan(1);
});

test('Z11: Ctrl+wheel zoom-out at the live edge keeps the end at now', async ({ page }) => {
  const url = `${GALLERY}?from=${encodeURIComponent(new Date(T - HOUR).toISOString())}&to=${encodeURIComponent(new Date(T).toISOString())}&refresh=off`;
  await open(page, url, T);
  await galleryReady(page);
  const f = frame(page, 'line-1');
  const plot = await plotOf(f);
  const box = await boxOf(f);
  const p = point(box, plot, 0.8);
  await page.mouse.move(p.x, p.y);
  const before = page.url();
  await zoomWheel(page, 0, 300);
  await waitUrlChange(page, before);
  const w = urlWindow(page);
  expect(w.to).toBeLessThanOrEqual(T);
  expect(w.to - w.from).toBeGreaterThan(HOUR);
});
