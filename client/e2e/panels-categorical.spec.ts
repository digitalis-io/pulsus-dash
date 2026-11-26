/**
 * Board bar charts against the PulsusDB fake through the http-mode BFF (plan #173 Part 3b §5; T22
 * §10.3): the coverage meter and its Narrow, fixed bounds through a reload, the board filter a click
 * toggles (interim: no panel query reads `f=` until #193), the Inspector on a bar, the listbox keys
 * and the baseline ghost, the selection across panels (and with a line panel's legend), and the
 * table view. The boards are created through the boards API on the 2026-01-01 00:00–01:00 window
 * of the `bars-*` transcripts. "Bar i" is band i of `data-plot` in draw order; a probe reads the
 * canvas pixel at the band centre, at 25 % of the bar's length.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { seriesColourIndex } from '../src/engine/canvas2d/palette.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';
import { fakeRequests, sec } from './fake.ts';
import { plotOf, type Plot } from './helpers.ts';

const FROM = Date.UTC(2026, 0, 1);
const TO = FROM + 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const boardUrl = (uid: string, extra = ''): string =>
  `/t/demo/board/${uid}?from=${encodeURIComponent(iso(FROM))}&to=${encodeURIComponent(iso(TO))}&refresh=off${extra}`;

/** `bars_by_version`'s values by name (T22 §10.2). */
const VALUES: Readonly<Record<string, number>> = {
  '2.29': 40,
  '2.30': 7,
  '2.31': 120,
  '2.32': 3,
  '2.33': 15,
};
const BY_VALUE = ['2.31', '2.29', '2.33', '2.30', '2.32'];

const bar = (
  id: string,
  title: string,
  text: string,
  grid: PanelInput['grid'],
  options?: Record<string, unknown>,
): PanelInput => ({
  id,
  title,
  text,
  grid,
  vis: options === undefined ? { kind: 'barchart' } : { kind: 'barchart', options },
});

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

const frameIn = (p: Locator): Locator => p.locator('[data-chart-frame]').first();
const listIn = (p: Locator): Locator => p.getByRole('listbox');

/** The panel is a drawn bar chart. */
async function drawn(p: Locator): Promise<void> {
  await expect(p).toHaveAttribute('data-panel-vis', 'barchart');
  await expect(frameIn(p)).toHaveAttribute('data-frame-ready', 'true');
}

/** The names of the listbox options, in draw order. */
async function names(p: Locator): Promise<string[]> {
  const texts = await listIn(p).getByRole('option').allTextContents();
  return texts.map((s) => s.slice(0, s.lastIndexOf(': ')));
}

async function valueAxis(p: Locator): Promise<{ min: number; max: number; mode: string }> {
  const raw = (await frameIn(p).getAttribute('data-value-axis')) ?? '';
  const [min = '0', max = '0', mode = ''] = raw.split(',');
  return { min: Number(min), max: Number(max), mode };
}

interface Geometry {
  readonly plot: Plot;
  readonly box: { x: number; y: number };
  readonly n: number;
  readonly min: number;
  readonly max: number;
}

async function geometry(p: Locator): Promise<Geometry> {
  const f = frameIn(p);
  const plot = await plotOf(f);
  const box = await f.boundingBox();
  if (box === null) throw new Error('no frame box');
  const n = await listIn(p).getByRole('option').count();
  const { min, max } = await valueAxis(p);
  return { plot, box, n, min, max };
}

/** The x of value `v` (horizontal bars), relative to the frame. */
const xOf = (g: Geometry, v: number): number =>
  g.plot.x + (g.plot.width * (v - g.min)) / (g.max - g.min);
/** The centre of band `i`, relative to the frame. */
const bandY = (g: Geometry, i: number): number => g.plot.y + ((i + 0.5) * g.plot.height) / g.n;

/** The probe point of bar `i` of value `v`, relative to the frame. */
const probeAt = (g: Geometry, i: number, v: number) => ({ x: xOf(g, 0.25 * v), y: bandY(g, i) });

type RGB = readonly [number, number, number];

/** The canvas pixel at frame point (x, y). */
async function pixel(p: Locator, x: number, y: number): Promise<RGB> {
  const canvas = frameIn(p).locator('canvas').first();
  return canvas.evaluate(
    (c: HTMLCanvasElement, at) => {
      const host = c.closest('[data-chart-frame]');
      const hb = host?.getBoundingClientRect();
      const cb = c.getBoundingClientRect();
      const dpr = c.width / cb.width;
      const ctx = c.getContext('2d');
      if (ctx === null || hb === undefined) return [-1, -1, -1] as const;
      const px = Math.floor((hb.left + at.x - cb.left) * dpr);
      const py = Math.floor((hb.top + at.y - cb.top) * dpr);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as const;
    },
    { x, y },
  );
}

/** Every bar's probe, in draw order (values by name). */
async function probes(p: Locator, values: Readonly<Record<string, number>>): Promise<RGB[]> {
  const g = await geometry(p);
  const ns = await names(p);
  const out: RGB[] = [];
  for (const [i, name] of ns.entries()) {
    const at = probeAt(g, i, values[name] ?? 0);
    out.push(await pixel(p, at.x, at.y));
  }
  return out;
}

const near = (a: RGB, b: RGB, tol = 2): boolean =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

/** A CSS colour token's RGB (`#rrggbb`). */
async function token(page: Page, name: string): Promise<RGB> {
  const hex = await page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim(),
    name,
  );
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

async function clickBar(page: Page, p: Locator, i: number, v: number): Promise<void> {
  const g = await geometry(p);
  const at = probeAt(g, i, v);
  await page.mouse.click(g.box.x + at.x, g.box.y + at.y);
}

async function hoverBar(page: Page, p: Locator, i: number, v: number): Promise<void> {
  const g = await geometry(p);
  const at = probeAt(g, i, v);
  await page.mouse.move(g.box.x + at.x, g.box.y + at.y);
}

const tooltip = (p: Locator): Locator => p.locator('[data-mark-tooltip]:not([hidden])');
const inspector = (page: Page): Locator => page.locator('[data-inspector]:not([data-closing])');
const filtersOf = (page: Page): string[] => new URL(page.url()).searchParams.getAll('f');

/** The page's BFF range requests (each one is one fake request), with their JSON bodies. */
function rangeRequests(page: Page): { from: number; to: number; query: string }[] {
  const seen: { from: number; to: number; query: string }[] = [];
  page.on('request', (r: Request) => {
    if (!r.url().includes('/api/dash/v1/query/promql/range')) return;
    const b = r.postDataJSON() as { from: number; to: number; query: string };
    seen.push({ from: b.from, to: b.to, query: b.query });
  });
  return seen;
}

/** Tabs from the page start until `target` has focus (at most 80 presses). */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** The active option's text of the panel's listbox. */
async function activeOption(p: Locator): Promise<string> {
  const list = listIn(p);
  const id = await list.getAttribute('aria-activedescendant');
  if (id === null) return '';
  return (await list.locator(`[id="${id}"]`).textContent()) ?? '';
}

test.describe('panels-categorical (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 1100 } });

  let uid: string | null = null;
  test.afterEach(async ({ request }) => {
    await deleteBoard(request, uid);
    uid = null;
  });

  test('e2e:categorical-coverage', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars coverage ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'Complete', 'bars_by_version', [0, 0, 4, 8]),
      bar('p-2', 'Warned', 'bars_warn', [4, 0, 4, 8]),
      bar('p-3', 'Truncated', 'bars_trunc', [8, 0, 4, 8]),
    ]);
    await page.goto(boardUrl(uid));
    for (const t of ['Complete', 'Warned', 'Truncated']) await drawn(panel(page, t));
    const meter = (t: string): Locator => panel(page, t).locator('[data-coverage-meter]');
    await expect(meter('Complete')).toHaveText('100 %');
    await expect(meter('Warned')).toContainText('limited (1 warning)');
    await meter('Warned').getByRole('button').click();
    await expect(page.getByRole('dialog').getByText('series limit reached')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(meter('Truncated')).toContainText(/^truncated/);
    await meter('Truncated').getByRole('button').click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Narrow/ })
      .click();
    await expect(page).toHaveURL(/\/t\/demo\/explore\/metrics\?/);
    const s = new URL(page.url()).searchParams;
    expect(s.get('q')).toBe('bars_trunc');
    expect(s.get('vis')).toBe('barchart');
  });

  test('e2e:bars-bounds', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars bounds ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'Both', 'bars_by_version', [0, 0, 4, 8], { min: 0, max: 500 }),
      bar('p-2', 'Max', 'bars_by_version', [4, 0, 4, 8], { max: 500 }),
      bar('p-3', 'Min', 'bars_by_version', [8, 0, 4, 8], { min: 500 }),
    ]);
    const check = async (): Promise<void> => {
      for (const t of ['Both', 'Max', 'Min']) await drawn(panel(page, t));
      await expect(frameIn(panel(page, 'Both'))).toHaveAttribute('data-value-axis', '0,500,manual');
      await expect(frameIn(panel(page, 'Max'))).toHaveAttribute('data-value-axis', '0,500,manual');
      await expect(frameIn(panel(page, 'Min'))).toHaveAttribute(
        'data-value-axis',
        '500,620,manual',
      );
      await expect(panel(page, 'Min').locator('[data-coverage-meter]')).toContainText(
        '5 values outside the fixed range',
      );
    };
    await page.goto(boardUrl(uid));
    await check();
    await page.reload();
    await check();
  });

  test('e2e:bars-filter', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars filter ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'Versions', 'bars_by_version', [0, 0, 6, 10]),
    ]);
    const sent = rangeRequests(page);
    await page.goto(boardUrl(uid));
    const p = panel(page, 'Versions');
    await drawn(p);
    expect(await names(p)).toEqual(BY_VALUE);
    const before = sent.filter((r) => r.query === 'bars_by_version').length;
    await clickBar(page, p, 0, 120);
    await expect.poll(() => filtersOf(page)).toEqual(['version=2.31']);
    await expect(page.getByRole('button', { name: /version/ }).first()).toBeVisible();
    // Interim (T22-007, #193): no panel query reads `f=`, so nothing runs again.
    await page.waitForTimeout(500);
    expect(sent.filter((r) => r.query === 'bars_by_version')).toHaveLength(before);
    await clickBar(page, p, 0, 120);
    await expect.poll(() => filtersOf(page)).toEqual([]);

    await page.goto(boardUrl(uid, '&f=version%3D2.30'));
    await drawn(panel(page, 'Versions'));
    await clickBar(page, panel(page, 'Versions'), 0, 120);
    await expect.poll(() => filtersOf(page)).toEqual(['version=2.31']);
  });

  test('e2e:bars-inspect', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars inspect ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'Versions', 'bars_by_version', [0, 0, 6, 10]),
    ]);
    await page.goto(boardUrl(uid));
    const p = panel(page, 'Versions');
    await drawn(p);
    await clickBar(page, p, 0, 120);
    const aside = inspector(page);
    await expect(aside.getByRole('heading', { level: 2 })).toHaveText('2.31');
    await expect(aside.locator('[data-inspector-value]')).toHaveText('120');
    await expect(aside.locator('[data-section="labels"]')).toContainText('version');
    await expect(aside.locator('[data-section="labels"]')).toContainText('2.31');
    const href = (await aside.locator('a[data-pivot="explore"]').getAttribute('href')) ?? '';
    const s = new URL(href, 'http://x').searchParams;
    expect(s.get('q')).toBe('bars_by_version');
    expect(s.get('vis')).toBe('barchart');
    await expect(aside.locator('[data-pivot="labelFilter"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(aside.locator('[data-section="pivots"]')).toContainText(
      'Filtering Explore by a label arrives with label filters',
    );
  });

  test('e2e:categorical-interactions', async ({ page, request }, info) => {
    test.setTimeout(180_000);
    uid = await createBoard(request, `bars keys ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'P1', 'bars_by_version', [0, 0, 6, 10]),
      bar('p-2', 'P2', 'bars_by_version', [6, 0, 6, 10]),
      {
        id: 'p-3',
        title: 'L',
        text: 'bars_by_version',
        grid: [0, 10, 12, 8],
        vis: { kind: 'line' },
      },
    ]);
    const sent = rangeRequests(page);
    await page.goto(boardUrl(uid));
    const p1 = panel(page, 'P1');
    const p2 = panel(page, 'P2');
    await drawn(p1);
    await drawn(p2);
    const load2 = await probes(p2, VALUES);

    await tabTo(page, listIn(p1));
    await expect.poll(() => activeOption(p1)).toBe('2.31: 120');
    await expect(tooltip(p1)).toContainText('2.31');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => activeOption(p1)).toBe('2.33: 15');
    await page.keyboard.press('Home');
    await expect.poll(() => activeOption(p1)).toBe('2.31: 120');
    await page.keyboard.press('End');
    await expect.poll(() => activeOption(p1)).toBe('2.32: 3');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect
      .poll(async () => (await frameIn(p2).getAttribute('data-selection-keys'))?.split(',').length)
      .toBe(3);
    const brushed = await probes(p2, VALUES);
    expect(near(brushed[3] ?? [0, 0, 0], load2[3] ?? [0, 0, 0])).toBe(false);
    await page.keyboard.press('Escape');
    await expect(frameIn(p2)).toHaveAttribute('data-selection-keys', '');
    await expect
      .poll(async () => (await probes(p2, VALUES)).every((c, i) => near(c, load2[i] ?? c)))
      .toBe(true);

    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect.poll(() => filtersOf(page)).toEqual(['version=2.31']);
    await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('2.31');

    await hoverBar(page, p1, 0, 120);
    await expect(tooltip(p1)).toContainText('Values are reduced over');

    await p1.getByRole('button', { name: 'Panel menu: P1' }).click();
    await page.getByRole('menuitem', { name: 'Show baseline ghost' }).click();
    await expect
      .poll(() => sent.filter((r) => r.from === FROM - DAY && r.to === TO - DAY).length)
      .toBe(1);
    expect(
      (await fakeRequests(request, { transcript: 'bars-by-version-base' })).some(
        (r) => r.start === sec(FROM - DAY),
      ),
    ).toBe(true);
    await expect(frameIn(p1)).toHaveAttribute('data-frame-ready', 'true');
    const g = await geometry(p1);
    const muted = await token(page, 'text-muted');
    const x60 = xOf(g, 60);
    const band = g.plot.height / g.n;
    let found = false;
    for (let dy = -band * 0.3; dy <= band * 0.3 && !found; dy += 1) {
      for (let dx = -2; dx <= 2 && !found; dx += 1) {
        found = near(await pixel(p1, x60 + dx, bandY(g, 0) + dy), muted);
      }
    }
    expect(found).toBe(true);
    await hoverBar(page, p1, 0, 120);
    await expect(tooltip(p1)).toContainText('baseline 60');
  });

  test('e2e:selection-empty', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars select ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'P1', 'bars_by_version', [0, 0, 6, 10]),
      bar('p-2', 'P2', 'bars_by_version', [6, 0, 6, 10]),
    ]);
    await page.goto(boardUrl(uid));
    const p1 = panel(page, 'P1');
    const p2 = panel(page, 'P2');
    await drawn(p1);
    await drawn(p2);
    // The keys from P2's table rows, in draw order.
    await listIn(p2).focus();
    await page.keyboard.press('Shift+T');
    const rows = p2.locator('[data-row-key]');
    await expect(rows).toHaveCount(5);
    const keys: Record<string, string> = {};
    for (const r of await rows.all()) {
      const name = (await r.locator('[role="gridcell"]').first().textContent())?.trim() ?? '';
      keys[name] = (await r.getAttribute('data-row-key')) ?? '';
    }
    await page.keyboard.press('Shift+T');
    await expect(frameIn(p2)).toHaveAttribute('data-frame-ready', 'true');
    const load = await probes(p2, VALUES);
    for (const [i, name] of BY_VALUE.entries()) {
      const want = await token(
        page,
        `series-${String(1 + seriesColourIndex({ key: keys[name] ?? '', labels: { version: name } }))}`,
      );
      expect(near(load[i] ?? [0, 0, 0], want), name).toBe(true);
    }
    // A pointer brush over P1's bars 0–1.
    const g = await geometry(p1);
    const x = g.box.x + xOf(g, 10);
    await page.mouse.move(x, g.box.y + bandY(g, 0));
    await page.mouse.down();
    await page.mouse.move(x, g.box.y + bandY(g, 1), { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await frameIn(p2).getAttribute('data-selection-keys'))?.split(',').length)
      .toBe(2);
    await page.mouse.move(0, 0);
    const brushed = await probes(p2, VALUES);
    for (const i of [0, 1])
      expect(near(brushed[i] ?? [0, 0, 0], load[i] ?? [0, 0, 0]), `bar ${String(i)}`).toBe(true);
    for (const i of [2, 3, 4])
      expect(near(brushed[i] ?? [0, 0, 0], load[i] ?? [0, 0, 0]), `bar ${String(i)}`).toBe(false);
    await page.keyboard.press('Escape');
    await expect(frameIn(p2)).toHaveAttribute('data-selection-keys', '');
    await expect
      .poll(async () => (await probes(p2, VALUES)).every((c, i) => near(c, load[i] ?? c)))
      .toBe(true);
  });

  test('e2e:selection-keys', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars keys2 ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'P1', 'bars_keys', [0, 0, 6, 10], { categoryBy: 'version' }),
      { id: 'p-2', title: 'P2', text: 'bars_keys', grid: [6, 0, 6, 10], vis: { kind: 'line' } },
    ]);
    await page.goto(boardUrl(uid));
    const p1 = panel(page, 'P1');
    const p2 = panel(page, 'P2');
    await drawn(p1);
    await expect(frameIn(p2)).toHaveAttribute('data-frame-ready', 'true');
    const A = '2.31 · region="eu"';
    const B = '2.31 · region="us"';
    expect(await names(p1)).toEqual([B, A]);
    const values = { [A]: 50, [B]: 70 };
    // The keys: P1's table rows.
    await listIn(p1).focus();
    await page.keyboard.press('Shift+T');
    const keyOf = async (name: string): Promise<string> =>
      (await p1.locator('[data-row-key]').filter({ hasText: name }).getAttribute('data-row-key')) ??
      '';
    const aKey = await keyOf(A);
    const bKey = await keyOf(B);
    await page.keyboard.press('Shift+T');
    await expect(frameIn(p1)).toHaveAttribute('data-frame-ready', 'true');
    const load = await probes(p1, values);

    await clickBar(page, p1, 1, 50);
    await expect(frameIn(p1)).toHaveAttribute('data-selection-keys', aKey);
    await page.mouse.move(0, 0);
    let now = await probes(p1, values);
    expect(near(now[0] ?? [0, 0, 0], load[0] ?? [0, 0, 0])).toBe(false);

    await p2.getByRole('button', { name: /^Select .*region="us"/ }).click();
    await expect(frameIn(p1)).toHaveAttribute('data-selection-keys', bKey);
    now = await probes(p1, values);
    expect(near(now[1] ?? [0, 0, 0], load[1] ?? [0, 0, 0])).toBe(false);
    expect(near(now[0] ?? [0, 0, 0], load[0] ?? [0, 0, 0])).toBe(true);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await clickBar(page, p1, 1, 50);
    await expect(inspector(page).locator('[data-section="details"]')).toContainText(aKey);
    await listIn(p1).focus();
    await page.keyboard.press('Shift+T');
    await expect(p1.locator(`[data-row-key="${aKey}"]`)).toHaveCount(1);
  });

  test('e2e:categorical-table-view', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `bars table ${info.project.name} ${crypto.randomUUID()}`, [
      bar('p-1', 'Many', 'bars_many', [0, 0, 12, 21]),
    ]);
    await page.goto(boardUrl(uid));
    const p = panel(page, 'Many');
    await drawn(p);
    const plot = await plotOf(frameIn(p));
    expect(plot.height).toBeGreaterThanOrEqual(588);
    expect(plot.height).toBeLessThan(602);
    await expect(p.locator('[data-coverage-meter]')).toHaveText('showing 42 of 250; kept min, max');
    await listIn(p).focus();
    await page.keyboard.press('Shift+T');
    const grid = p.getByRole('grid', { name: 'Many' });
    await expect(grid).toBeFocused();
    await expect(p.getByText('250 rows · 42 drawn')).toBeVisible();
    await page.keyboard.press('End');
    await expect(grid.locator('[aria-rowindex="251"]')).toHaveCount(1);
    const download = page.waitForEvent('download');
    await p.getByRole('button', { name: 'Export CSV' }).click();
    const file = await (await download).path();
    const csv = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
    expect(csv[0]).toBe('name,value,baseline,state,drawn,shown as');
    expect(csv).toHaveLength(251);
    expect(csv.slice(1).filter((l) => l.split(',')[4] === 'no')).toHaveLength(208);
    const one = csv.slice(1).find((l) => l.startsWith('1,'));
    expect(one?.split(',')[1]).toBe('');
  });
});
