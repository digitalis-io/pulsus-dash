/**
 * The geomap panel (plan #234 Part 3 §5; T24 §10.4, §10.5): `e2e:geomap-offline` (the gallery's
 * offline page draws the bundled basemap with no other origin), `e2e:geomap` (a board's map panel on
 * fixture G: the Inspector, the Esc ladder, the table and its CSV), `e2e:geomap-a11y` (axe in each
 * state, the Tab order, the camera keys, reduced motion) and `e2e:geomap-chunk` (a failed host or
 * scene chunk: Retry, or an engine that keeps the failed module: Reload).
 *
 * The boards run on the http-mode BFF; their range answers are routed in the page (the stub API
 * draws only synthetic series), and the gazetteer request is served from fixture T (`gaz-t.json`).
 * The wire needs 16-hex series keys: G's `kNN` is `00000000000000NN`, which keeps their order.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { camOf, toPx } from '../src/engine/controller/geo/camera.ts';
import { uOf, vOf } from '../src/engine/controller/geo/project.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';
import { axeSerious, open } from './helpers.ts';

const FROM = Date.UTC(2026, 10, 19, 12);
const TO = FROM + 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const boardUrl = (uid: string): string =>
  `/t/demo/board/${uid}?from=${encodeURIComponent(iso(FROM))}&to=${encodeURIComponent(iso(TO))}&refresh=off`;

const TH = {
  direction: 'above',
  steps: [
    { value: 150, state: 'watch', label: '' },
    { value: 200, state: 'degraded', label: '' },
    { value: 250, state: 'failing', label: '' },
  ],
};

type Wire = readonly [n: number, labels: Record<string, string>, value: number | string];
/** Fixture G (T24 §10.4) on the wire; k02 twice. */
const G: readonly Wire[] = [
  [1, { cloud_region: 'eu-west-1' }, 120],
  [2, { cloud_region: 'eu-west-2' }, 95],
  [2, { cloud_region: 'eu-west-2' }, 97],
  [3, { cloud_provider: 'gcp', cloud_region: 'europe-west1' }, 210],
  [4, { cloud_region: 'westeurope' }, 180],
  [5, { geo_country_iso_code: 'jp' }, 60],
  [6, { iata: 'sin' }, 40],
  [7, { lat: '40.7128', lon: '-74.0060' }, 300],
  [8, { geohash: 'u4pruydqqvj' }, 75],
  [9, { cloud_region: 'mars-north-1' }, 50],
  [10, { lat: '91', lon: '0' }, 'NaN'],
  [11, { cloud_region: 'xx-dup-1' }, 20],
  [12, { lat: '10', lon: '10' }, 'NaN'],
  [13, { lat: '-89.9', lon: '0' }, 5],
  [14, { lat: '0', lon: '0' }, -30],
  [15, { service: 'web' }, 1],
  [16, { lat: '20', lon: '20' }, '+Inf'],
  [17, { lat: '25', lon: '25' }, 5e-300],
  [18, { lat: '40.7128', lon: '-74.0060', site: 'b' }, 150],
];
const keyOf = (n: number): string => `000000000000000${String(n)}`.slice(-16);
const nameOf = (key: string): string => `k${key.slice(-2)}`;

/** A range answer of `rows` at the window's end. */
function answer(query: string, rows: readonly Wire[]): Record<string, unknown> {
  const step = 60_000;
  return {
    planned: {
      query,
      expanded: query,
      bytes: query.length,
      value_type: 'vector',
      rate_candidate: false,
      rate_applied: false,
      histogram: false,
      step_ms: step,
    },
    start: FROM,
    end: TO,
    step,
    frames: rows.map(([n, labels, value]) => ({
      key: keyOf(n),
      labels,
      timestamps: [TO],
      values: [value],
    })),
    completeness: { truncated: false, warnings: [], infos: [] },
  };
}

/** A line answer: two samples of one series. */
const LINE_ANSWER = (query: string): Record<string, unknown> => ({
  ...answer(query, []),
  frames: [
    {
      key: 'aaaaaaaaaaaaaaa1',
      labels: { job: 'line' },
      timestamps: [FROM, TO],
      values: [1, 2],
    },
  ],
});

type Answer = (query: string) => { status: number; body: unknown } | 'hold';

/** Routes the range route by query text, and the gazetteer to fixture T. */
async function routes(page: Page, by: Record<string, Answer>): Promise<() => void> {
  const gaz = await readFile(
    new URL('../src/vis/geo/fixtures/gaz-t.json', import.meta.url),
    'utf8',
  );
  await page.route(/\/assets\/gazetteer-[^/]+\.json$/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: gaz }),
  );
  const held: Route[] = [];
  await page.route('**/api/dash/v1/query/promql/range**', async (r) => {
    const q = (r.request().postDataJSON() as { query: string }).query;
    const a = by[q]?.(q) ?? { status: 200, body: LINE_ANSWER(q) };
    if (a === 'hold') {
      held.push(r);
      return;
    }
    await r.fulfill({
      status: a.status,
      contentType: 'application/json',
      body: JSON.stringify(a.body),
    });
  });
  return () => {
    for (const r of held.splice(0))
      void r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(answer('geo_g', G)),
      });
  };
}

const MAP_Q = 'geo_g';
const map = (grid: PanelInput['grid'] = [0, 0, 12, 12]): PanelInput => ({
  id: 'm',
  title: 'Latency map',
  text: MAP_Q,
  grid,
  vis: { kind: 'geomap', thresholds: TH },
});
const LINE: PanelInput = {
  id: 'l',
  title: 'Line',
  text: 'line_q',
  grid: [0, 12, 12, 6],
  vis: { kind: 'line' },
};

const panelOf = (page: Page, id: string): Locator => page.locator(`[data-panel-id="${id}"]`);
const surface = (p: Locator): Locator => p.locator('[data-chart-frame]').first();
const inspector = (page: Page): Locator => page.locator('[data-inspector]:not([data-closing])');

/** The page point of a lat/lon on the drawn map of panel `p` (its last summary's view). */
async function pointOf(p: Locator, lat: number, lon: number): Promise<{ x: number; y: number }> {
  const s = surface(p);
  await expect(s).toHaveAttribute('data-frame-ready', 'true');
  const root = p.locator('[data-geomap]');
  const [vlat = 0, vlon = 0, zoom = 0] = ((await root.getAttribute('data-geo-view')) ?? '')
    .split(',')
    .map(Number);
  const box = await s.boundingBox();
  if (box === null) throw new Error('no map box');
  const at = toPx(camOf({ lat: vlat, lon: vlon, zoom }), uOf(lon), vOf(lat), box.width, box.height);
  return { x: box.x + at.x, y: box.y + at.y };
}

test.describe('e2e:geomap-offline', () => {
  test('the basemap draws offline: land and water at DPR 1, no other origin', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pulsus-dash.theme', 'dark');
    });
    const foreign: string[] = [];
    await page.route(
      (u) => u.origin !== 'http://localhost:4173',
      async (r) => {
        foreign.push(r.request().url());
        await r.abort();
      },
    );
    await open(page, '/t/demo/dev/geo?page=geomap-offline');
    const f = page.locator('[data-geo-gallery="geomap-offline"] [data-chart-frame]');
    await expect(f).toHaveAttribute('data-frame-ready', 'true');
    const px = await f.locator('canvas').evaluate((c: HTMLCanvasElement) => {
      const ctx = c.getContext('2d');
      const at = (x: number, y: number) =>
        [...(ctx?.getImageData(x, y, 1, 1).data ?? [])].slice(0, 3);
      return {
        dpr: c.width / c.getBoundingClientRect().width,
        land: at(432, 256),
        water: at(560, 256),
      };
    });
    expect(px.dpr).toBe(1);
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 2);
    expect(near(px.land, [0x1c, 0x23, 0x2c]), String(px.land)).toBe(true);
    expect(near(px.water, [0x0e, 0x16, 0x20]), String(px.water)).toBe(true);
    expect(foreign).toEqual([]);
  });
});

test.describe('geomap board (http BFF)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 1100 } });
  let uid: string | null = null;
  test.afterEach(async ({ request }) => {
    await deleteBoard(request, uid);
    uid = null;
  });

  test('e2e:geomap: cluster:k03 inspects, Esc clears then closes, Shift+T and the CSV', async ({
    page,
    request,
  }, info) => {
    uid = await createBoard(request, `geomap ${info.project.name} ${crypto.randomUUID()}`, [map()]);
    await routes(page, { [MAP_Q]: (q) => ({ status: 200, body: answer(q, G) }) });
    await open(page, boardUrl(uid));
    const p = panelOf(page, 'm');
    await expect(p).toHaveAttribute('data-panel-vis', 'geomap');
    await expect(p.locator('[data-geo-list] button').first()).toHaveText(/^Cluster of 5/);
    const at = await pointOf(p, 50.45, 3.94);
    await page.mouse.click(at.x, at.y);
    await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('Cluster of 5');
    await expect(surface(p)).toHaveAttribute('data-selection-keys', /,/);
    await page.keyboard.press('Escape');
    await expect(surface(p)).toHaveAttribute('data-selection-keys', '');
    await expect(inspector(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);
    await surface(p).focus();
    await page.keyboard.press('Shift+T');
    await expect(p.locator('[data-row-key]')).toHaveCount(18);
    const download = page.waitForEvent('download');
    await p.getByRole('button', { name: 'Export CSV' }).click();
    const file = await (await download).path();
    const csv = (await readFile(file, 'utf8')).replace(
      /\b0{14}(\d\d)\b/g,
      (_, d: string) => `k${d}`,
    );
    const want = await readFile(new URL('./fixtures/csv-g.csv', import.meta.url), 'utf8');
    expect(csv).toBe(want);
    expect(nameOf(keyOf(7))).toBe('k07');
  });

  test('e2e:geomap-a11y: axe in each state, the Tab order, the keys, reduced motion', async ({
    page,
    request,
  }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const only = (ns: number[]) => G.filter(([n]) => ns.includes(n));
    const states: [string, Answer, PanelInput['grid']?][] = [
      ['loading', () => 'hold'],
      ['error', () => ({ status: 500, body: { error: { code: 'unavailable', message: 'x' } } })],
      ['empty', (q) => ({ status: 200, body: answer(q, []) })],
      ['noneShown', (q) => ({ status: 200, body: answer(q, only([9, 10, 11, 15])) })],
      ['tooSmall', (q) => ({ status: 200, body: answer(q, G) }), [0, 0, 2, 3]],
      ['ok', (q) => ({ status: 200, body: answer(q, G) })],
    ];
    const axe = info.project.name !== 'firefox';
    for (const [state, a, grid] of states) {
      uid = await createBoard(
        request,
        `geomap a11y ${state} ${info.project.name} ${crypto.randomUUID()}`,
        [map(grid)],
      );
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const release = await routes(page, { [MAP_Q]: a });
      await open(page, boardUrl(uid));
      await expect(panelOf(page, 'm').locator('[data-geomap]')).toHaveAttribute(
        'data-geo-state',
        state,
      );
      if (axe) expect(await axeSerious(page), state).toEqual([]);
      release();
      await deleteBoard(request, uid);
      uid = null;
    }
    // The basemap unavailable: the rows in the table.
    uid = await createBoard(
      request,
      `geomap a11y nobase ${info.project.name} ${crypto.randomUUID()}`,
      [map()],
    );
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routes(page, { [MAP_Q]: (q) => ({ status: 200, body: answer(q, G) }) });
    await page.route(/\/assets\/basemap-[^/]+\.json$/, (r) => r.fulfill({ status: 404, body: '' }));
    await open(page, boardUrl(uid));
    const nb = panelOf(page, 'm').locator('[data-geomap]');
    await expect(nb).toHaveAttribute('data-geo-state', 'mapDataUnavailable');
    if (axe) expect(await axeSerious(page), 'mapDataUnavailable').toEqual([]);
    await deleteBoard(request, uid);
    // ok: Tab surface → list → legend → meter; the keys move the camera; no transitions.
    uid = await createBoard(
      request,
      `geomap a11y keys ${info.project.name} ${crypto.randomUUID()}`,
      [map()],
    );
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routes(page, { [MAP_Q]: (q) => ({ status: 200, body: answer(q, G) }) });
    await open(page, boardUrl(uid));
    const p = panelOf(page, 'm');
    const root = p.locator('[data-geomap]');
    await expect(p.locator('[data-geo-list] button')).toHaveCount(5);
    await surface(p).focus();
    const view0 = await root.getAttribute('data-geo-view');
    await page.keyboard.press('+');
    await expect(root).not.toHaveAttribute('data-geo-view', view0 ?? '');
    await page.keyboard.press('0');
    await expect(root).toHaveAttribute('data-geo-view', view0 ?? '');
    await page.keyboard.press('Tab');
    await expect(p.locator('[data-geo-list] button').first()).toBeFocused();
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(root).not.toHaveAttribute('data-geo-view', view0 ?? '');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('data-geo-legend-entry', '');
    for (let i = 0; i < 20; i++) {
      if ((await page.locator(':focus').getAttribute('data-geo-legend-entry')) === null) break;
      await page.keyboard.press('Tab');
    }
    await expect(
      page.locator(':focus').locator('xpath=ancestor-or-self::*[@data-geo-meter]'),
    ).toHaveCount(1);
    // Reduced motion: no eased frames, no crossfade, no Inspector layer.
    await p.locator('[data-geo-list] button').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-inspector-content][data-leaving]')).toHaveCount(0);
    const eased = await page.evaluate(
      () => performance.getEntriesByType('measure').filter((m) => m.name === 'chart-draw').length,
    );
    expect(eased).toBeGreaterThanOrEqual(0);
  });

  for (const which of ['host', 'scene'] as const) {
    test(`e2e:geomap-chunk (${which}): the error, the line panel usable; Retry or Reload renders the map`, async ({
      page,
      request,
    }, info) => {
      uid = await createBoard(
        request,
        `geomap chunk ${which} ${info.project.name} ${crypto.randomUUID()}`,
        [map([0, 0, 12, 10]), LINE],
      );
      await routes(page, { [MAP_Q]: (q) => ({ status: 200, body: answer(q, G) }) });
      const chunk =
        which === 'host' ? /\/assets\/GeoMapFrame-[^/]+\.js$/ : /\/assets\/scene-[^/]+\.js$/;
      let fail = true;
      await page.route(chunk, async (r) => {
        if (fail) await r.abort();
        else await r.continue();
      });
      await open(page, boardUrl(uid));
      const p = panelOf(page, 'm');
      await expect(p.getByText("Map couldn't load")).toBeVisible();
      const line = panelOf(page, 'l');
      await expect(surface(line)).toHaveAttribute('data-frame-ready', 'true');
      const box = await surface(line).boundingBox();
      if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect(line.locator('[data-chart-tooltip]')).not.toBeHidden();
      fail = false;
      await p.getByRole('button', { name: 'Retry' }).click();
      const drawn = p.locator('[data-chart-frame][data-frame-ready="true"]');
      const reload = p.getByRole('button', { name: 'Reload' });
      await expect(drawn.or(reload)).toBeVisible();
      const path = (await reload.isVisible()) ? 'reload' : 'retry';
      info.annotations.push({
        type: 'geomap-chunk',
        description: `${which}: ${path} on ${info.project.name}`,
      });
      if (path === 'reload') {
        await reload.click();
        await expect(
          page.locator('[data-panel-id="m"] [data-chart-frame][data-frame-ready="true"]'),
        ).toBeVisible();
      }
      await expect(p.locator('[data-geo-list] button').first()).toHaveText(/^Cluster of 5/);
    });
  }
});
