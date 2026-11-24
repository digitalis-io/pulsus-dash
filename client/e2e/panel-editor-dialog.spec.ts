/**
 * The panel editor dialog (#90, plan §5.2 and Appendix C): a centred, fixed-size modal window with
 * a live preview, in Chromium, Firefox and WebKit on the stub server. No fake clock: it replaces the
 * page's User Timing methods, which the probe reads (b-1's window is relative).
 *
 * Frame timing (plan §5.2): `arm(type)` registers a one-shot capture listener for the next input
 * event. It records `t0`, takes snapshot `f1` in the next animation frame, and `f2` in the one
 * after. In the `f1` callback it also observes the root element with a new `ResizeObserver`, whose
 * first callback runs in the same frame after its animation callbacks and layout, before its
 * paint: snapshot `p1` is what frame 1 paints.
 *
 * Plan #64 (A.5): the Query field is the PromQL editor; a query runs on Shift+Enter, a vis change
 * makes no request, and the stub's `stub:query` marks (`{ kind, query }`) count the requests.
 */
import { expect, test, type Page } from '@playwright/test';

interface Snap {
  t: number;
  title: string | null;
  /** The preview body's text when it shows no chart, else null. */
  body: string | null;
  frames: number;
  pending: number;
  label: string | null;
  frameId: string | null;
  inked: boolean;
  /** FNV-1a 32-bit of the preview canvas's RGBA bytes; null without a canvas. */
  fp: number | null;
  canvasCss: [number, number] | null;
  hostBox: [number, number] | null;
}

interface Armed {
  t0: number;
  f1: Snap;
  p1: Snap;
  f2: Snap;
}

interface Probe {
  draws: { kind: string; frame: string | null; t: number }[];
  marks: { kind: string; query: string; t: number }[];
  snap: () => Snap;
  arm: (type: string, key?: string) => void;
  armed: Promise<Armed> | null;
}

declare global {
  interface Window {
    __probe: Probe;
  }
}

/** Installed in every document: the User Timing observers and the snapshot functions. */
function installProbe(): void {
  const probe: Probe = {
    draws: [],
    marks: [],
    armed: null,
    snap: () => {
      const pv = document.querySelector('[data-panel-preview]');
      const body = pv?.querySelector<HTMLElement>('[data-preview-body]') ?? null;
      const host = pv?.querySelector<HTMLElement>('[data-preview-host]') ?? null;
      const frame = pv?.querySelector<HTMLElement>('[data-chart-frame]') ?? null;
      const canvas = pv?.querySelector('canvas') ?? null;
      let inked = false;
      let fp: number | null = null;
      if (canvas !== null && canvas.width > 0 && canvas.height > 0) {
        const ctx = canvas.getContext('2d');
        const px = ctx?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (px !== undefined) {
          let h = 0x811c9dc5;
          for (let i = 0; i < px.length; i++) {
            const v = px[i] ?? 0;
            if (i % 4 === 3 && v > 0) inked = true;
            h ^= v;
            h = Math.imul(h, 0x01000193);
          }
          fp = h >>> 0;
        }
      } else if (canvas !== null) {
        fp = 0;
      }
      return {
        t: performance.now(),
        title: pv?.querySelector('[data-preview-title]')?.textContent ?? null,
        body: body === null || frame !== null ? null : body.textContent.trim(),
        frames: pv?.querySelectorAll('[data-chart-frame]').length ?? 0,
        pending: pv?.querySelectorAll('[data-chart-pending]').length ?? 0,
        label: canvas?.getAttribute('aria-label') ?? null,
        frameId: frame?.dataset['frameId'] ?? null,
        inked,
        fp,
        canvasCss: canvas === null ? null : [canvas.clientWidth, canvas.clientHeight],
        hostBox: host === null ? null : [host.clientWidth, host.clientHeight],
      };
    },
    arm: (type, key) => {
      probe.armed = new Promise<Armed>((resolve) => {
        const on = (e: Event): void => {
          if (key !== undefined && (e as KeyboardEvent).key !== key) return;
          window.removeEventListener(type, on, true);
          const t0 = performance.now();
          requestAnimationFrame(() => {
            const f1 = probe.snap();
            let p1: Snap | null = null;
            const ro = new ResizeObserver(() => {
              p1 ??= probe.snap();
              ro.disconnect();
            });
            ro.observe(document.documentElement);
            requestAnimationFrame(() => {
              const f2 = probe.snap();
              resolve({ t0, f1, p1: p1 ?? f1, f2 });
            });
          });
        };
        window.addEventListener(type, on, true);
      });
    },
  };
  window.__probe = probe;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name !== 'chart-draw') continue;
      const d = (e as PerformanceMeasure).detail as { kind?: string; frame?: string | null } | null;
      probe.draws.push({ kind: d?.kind ?? '', frame: d?.frame ?? null, t: e.startTime });
    }
  }).observe({ type: 'measure' });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name !== 'stub:query') continue;
      const d = (e as PerformanceMark).detail as Omit<Probe['marks'][number], 't'>;
      probe.marks.push({ ...d, t: e.startTime });
    }
  }).observe({ type: 'mark' });
}

const KINDS = ['Auto', 'Line', 'Bars', 'Heatmap', 'Stat', 'Logs'] as const;
type Kind = (typeof KINDS)[number];
const LOGS = 'A metric query has no log lines. Choose Auto or a chart.';

function editor(page: Page) {
  const d = page.getByRole('dialog', { name: 'Edit panel' });
  return { d, pv: d.getByRole('region', { name: 'Preview' }) };
}

/** b-1 → Edit board → Panel menu: Request rate → Edit panel. */
async function openEditor(page: Page, o: { delayMs?: number } = {}): Promise<void> {
  await page.addInitScript(installProbe);
  if (o.delayMs !== undefined) {
    await page.addInitScript((ms) => {
      localStorage.setItem('pulsus-dash.stub.queryDelayMs', String(ms));
    }, o.delayMs);
  }
  await page.goto('/t/demo/board/b-1');
  await page.locator('html[data-shell-ready="true"]').waitFor();
  await page.getByRole('button', { name: 'Edit board' }).click();
  await expect(page.locator('[data-drag-handle]')).toHaveCount(4);
  await reopen(page);
  // The pointer stays where the Edit panel item was, which a later viewport can put over the
  // preview's chart; WebKit then sends a pointer move after a layout change, and the chart draws
  // its crosshair into the canvas the fingerprints read. Park it in the corner, off the dialog.
  await page.mouse.move(0, 0);
}

async function reopen(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Panel menu: Request rate/ }).click();
  await page.getByRole('menuitem', { name: 'Edit panel' }).click();
  await editor(page).d.waitFor();
  await query(page).waitFor();
}

/** The PromQL editor of the Query field (plan #64 §3.8). */
const query = (page: Page) => editor(page).d.getByRole('textbox', { name: 'Query' });

/**
 * Replaces the editor's one-line text with `text`: End, then Backspace over the old text. In
 * Firefox neither select-all nor Shift+Home selects inside the editor's shadow root.
 */
async function setQuery(page: Page, text: string): Promise<void> {
  const box = query(page);
  await box.click();
  await page.keyboard.press('End');
  const old = (await box.textContent()) ?? '';
  for (let i = 0; i < old.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
  await expect(box).toHaveText(text);
}

/** Runs the editor's text (Shift+Enter, T09-004); the key press is armed. */
async function runQuery(page: Page): Promise<Armed> {
  await query(page).focus();
  await arm(page, 'keydown', 'Enter');
  await page.keyboard.press('Shift+Enter');
  return armed(page);
}

/**
 * Escape until the dialog closes: in the editor, Esc closes an open completion list first, then
 * moves to Run query; Esc there closes the dialog (T09-004).
 */
async function closeByEscape(page: Page): Promise<void> {
  const { d } = editor(page);
  for (let i = 0; i < 3 && (await d.isVisible()); i++) await page.keyboard.press('Escape');
  await expect(d).toBeHidden();
}

/** b-1's Request rate query. */
const P1_TEXT = 'sum(rate(http_requests_total[5m]))';

/** The preview's chart has drawn: summary ready and no progress over it. */
async function previewReady(page: Page): Promise<void> {
  const { pv } = editor(page);
  await expect(pv.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(1);
  await expect(pv.locator('[data-chart-pending]')).toHaveCount(0);
}

const settled = (page: Page): Promise<Snap> =>
  page.evaluate(
    () =>
      new Promise<Snap>((r) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            r(window.__probe.snap());
          });
        });
      }),
  );

/** The reference image of the preview once it shows `label` and has drawn. */
async function reference(page: Page, label: RegExp): Promise<number | null> {
  const { pv } = editor(page);
  await expect(pv.locator('canvas')).toHaveAttribute('aria-label', label);
  await previewReady(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return (await settled(page)).fp;
}

const arm = (page: Page, type: string, key?: string): Promise<void> =>
  page.evaluate(
    ([t, k]) => {
      window.__probe.arm(t, k ?? undefined);
    },
    [type, key ?? null] as const,
  );

const armed = (page: Page): Promise<Armed> =>
  page.evaluate(async () => {
    const a = window.__probe.armed;
    if (a === null) throw new Error('not armed');
    return a;
  });

/** Picks visualisation `k` with the keyboard; Enter is armed. */
async function pick(page: Page, k: Kind): Promise<Armed> {
  const { d } = editor(page);
  await d.getByRole('button', { name: /Visualisation$/ }).click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Home');
  for (let i = 0; i < KINDS.indexOf(k); i++) await page.keyboard.press('ArrowDown');
  await arm(page, 'keydown', 'Enter');
  await page.keyboard.press('Enter');
  return armed(page);
}

const marksSince = (page: Page, t0: number) =>
  page.evaluate((t) => window.__probe.marks.filter((m) => m.t >= t), t0);

const draws = (page: Page, kind: string, s: Snap) =>
  page.evaluate(([k, id]) => window.__probe.draws.filter((x) => x.kind === k && x.frame === id), [
    kind,
    s.frameId,
  ] as const);

const LABEL: Readonly<Record<string, RegExp>> = {
  line: /^Request rate: line chart/,
  bars: /^Request rate: stacked bar chart/,
  stat: /^Request rate: stat/,
  heatmap: /^Request rate: heatmap/,
};

/** A cached pick: no request, the picked image painted in frame 1, by the preview's own frame. */
async function expectCachedPick(
  page: Page,
  a: Armed,
  kind: string,
  fp: number | null,
): Promise<void> {
  expect(await marksSince(page, a.t0)).toEqual([]);
  expect(a.p1.body).toBeNull();
  expect(a.p1.frames).toBe(1);
  expect(a.p1.pending).toBe(0);
  expect(a.p1.fp).toBe(fp);
  const inFrame1 = (await draws(page, kind, a.p1)).filter((x) => a.t0 < x.t && x.t < a.p1.t);
  expect(inFrame1.length).toBeGreaterThan(0);
  expect(a.f2.pending).toBe(0);
  expect(a.f2.fp).toBe(fp);
}

test.describe('panel editor dialog', () => {
  test('E1 centred, fixed size, dimmed', async ({ page }) => {
    await openEditor(page);
    const { d } = editor(page);
    const box = await d.boundingBox();
    expect(Math.abs((box?.width ?? 0) - 798)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((box?.height ?? 0) - 718)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((box?.x ?? 0) - 321)).toBeLessThanOrEqual(1);
    expect(Math.abs((box?.y ?? 0) - 91)).toBeLessThanOrEqual(1);
    const [bg, backdrop] = await page.evaluate(() => {
      const el = document.elementFromPoint(8, 450);
      const probe = document.createElement('div');
      probe.style.background = 'var(--backdrop)';
      document.documentElement.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [el === null ? '' : getComputedStyle(el).backgroundColor, want];
    });
    expect(bg).toBe(backdrop);
  });

  test('E2 cannot be moved or resized', async ({ page }) => {
    await openEditor(page);
    const { d } = editor(page);
    const box = await d.boundingBox();
    if (box === null) throw new Error('no box');
    const heading = await d.getByRole('heading', { name: 'Edit panel' }).boundingBox();
    if (heading === null) throw new Error('no heading');
    const drag = async (x: number, y: number, dx: number, dy: number): Promise<void> => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 10 });
      await page.mouse.up();
    };
    await drag(heading.x + 4, heading.y + heading.height / 2, 200, 100);
    expect(await d.boundingBox()).toEqual(box);
    await drag(box.x + box.width - 1, box.y + box.height - 1, 50, 50);
    expect(await d.boundingBox()).toEqual(box);
    await expect(d).toBeVisible();
    expect(await d.evaluate((e) => getComputedStyle(e).resize)).toBe('none');
  });

  test('E3 narrowest width', async ({ page }) => {
    await openEditor(page);
    const { d } = editor(page);
    for (const [vw, vh, w, h] of [
      [1024, 768, 798, 718],
      [800, 600, 750, 550],
    ] as const) {
      await page.setViewportSize({ width: vw, height: vh });
      await expect
        .poll(async () => Math.round((await d.boundingBox())?.width ?? 0), { timeout: 5_000 })
        .toBe(w);
      const box = await d.boundingBox();
      if (box === null) throw new Error('no box');
      expect(Math.abs(box.height - h), `${String(vw)} height`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(box.x - (vw - w) / 2), `${String(vw)} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y - (vh - h) / 2), `${String(vw)} y`).toBeLessThanOrEqual(1);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw);
      expect(box.y + box.height).toBeLessThanOrEqual(vh);
      expect(await d.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      const overflow = await d.evaluate((e) => {
        const right = e.getBoundingClientRect().right;
        return [...e.querySelectorAll('*')]
          .filter((c) => c.getBoundingClientRect().right > right + 0.5)
          .map((c) => c.tagName);
      });
      expect(overflow, `${String(vw)} overflow`).toEqual([]);
    }
  });

  test('E4 title within one frame', async ({ page }) => {
    await openEditor(page);
    const { d } = editor(page);
    await previewReady(page);
    await d.getByRole('textbox', { name: 'Title' }).focus();
    await page.keyboard.press('End');
    await arm(page, 'input');
    await page.keyboard.type('X');
    const a = await armed(page);
    expect(a.f1.title).toBe('Request rateX');
    expect(a.f1.label ?? '').toMatch(/^Request rateX/);
  });

  test('E5 focus contained; Esc returns focus', async ({ page }) => {
    await openEditor(page);
    const { d } = editor(page);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      expect(await d.evaluate((e) => e.contains(document.activeElement)), `tab ${String(i)}`).toBe(
        true,
      );
    }
    // From the editor, Esc moves to Run query first (T09-004).
    await page.keyboard.press('Escape');
    if (await d.isVisible()) await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(page.getByRole('button', { name: 'Panel menu: Request rate' })).toBeFocused();
  });

  test('E6 backdrop click closes and keeps the draft', async ({ page }) => {
    await openEditor(page);
    const { d } = editor(page);
    await d.getByRole('textbox', { name: 'Title' }).focus();
    await page.keyboard.press('End');
    await page.keyboard.type('Z');
    await page.mouse.click(8, 450);
    await expect(d).toBeHidden();
    await expect(page.getByRole('heading', { level: 3, name: 'Request rateZ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  test('E7 visualisation: from the cache at once', async ({ page }) => {
    await openEditor(page);
    const { pv } = editor(page);
    const fp: Record<string, number | null> = {};
    fp['line'] = await reference(page, LABEL['line'] ?? /./);
    await pick(page, 'Bars');
    fp['bars'] = await reference(page, LABEL['bars'] ?? /./);
    await pick(page, 'Stat');
    fp['stat'] = await reference(page, LABEL['stat'] ?? /./);
    expect(new Set([fp['line'], fp['bars'], fp['stat']]).size).toBe(3);
    const frameId = () => pv.locator('[data-chart-frame]').getAttribute('data-frame-id');
    for (const [k, kind, newFrame] of [
      ['Line', 'line', true],
      ['Stat', 'stat', true],
      ['Line', 'line', null],
      ['Bars', 'bars', false],
    ] as const) {
      const prev = await frameId();
      const a = await pick(page, k);
      if (newFrame === null) {
        // Back to a line chart, as the setup for line → bars on the kept canvas.
        await reference(page, LABEL['line'] ?? /./);
        continue;
      }
      await expectCachedPick(page, a, kind, fp[kind] ?? null);
      if (newFrame) expect(a.p1.frameId, kind).not.toBe(prev);
      else expect(a.p1.frameId, kind).toBe(prev);
      await reference(page, LABEL[kind] ?? /./);
    }
  });

  test('E8 query: request on Run, progress, then the result', async ({ page }) => {
    await openEditor(page, { delayMs: 400 });
    const { pv } = editor(page);
    await previewReady(page);
    await query(page).focus();
    await page.keyboard.press('End');
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.type('1');
    // Typing changes the draft only (plan #64 §4.4).
    await expect(
      editor(page).d.getByText('Press Shift+Enter or Run query to update the preview.'),
    ).toBeVisible();
    expect(await marksSince(page, t0)).toEqual([]);
    const a = await runQuery(page);
    const marks = (await marksSince(page, a.t0)).filter(
      (m) => m.kind === 'range' && m.query.endsWith('1') && m.t < a.f1.t,
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(a.f1.body).toBe('Loading');
    expect(a.f1.frames).toBe(0);
    await expect(pv.locator('canvas')).toHaveAttribute(
      'aria-label',
      /^Request rate: line chart, 3 series/,
      { timeout: 5_000 },
    );
  });

  test('E9 language: LogQL makes no PromQL request', async ({ page }) => {
    await openEditor(page, { delayMs: 400 });
    const { d, pv } = editor(page);
    await previewReady(page);
    await d.getByRole('button', { name: /Query language$/ }).click();
    await page.getByRole('listbox').waitFor();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await arm(page, 'keydown', 'Enter');
    await page.keyboard.press('Enter');
    const a = await armed(page);
    // The text is kept and runs as LogQL (plan #67): the stub answers log lines, which a Line
    // panel does not draw.
    await expect(
      pv.getByText(
        'Line, Heatmap and Stat draw metric queries. Choose Auto, Logs or Bars for log lines.',
      ),
    ).toBeVisible();
    await expect(d.getByRole('button', { name: 'LogQL Query language' })).toBeVisible();
    expect(await marksSince(page, a.t0)).toEqual([]);
  });

  test('E10 visualisation: a notice at once, no request', async ({ page }) => {
    await openEditor(page, { delayMs: 400 });
    const { pv } = editor(page);
    await previewReady(page);
    // Request rate has no buckets: the heatmap is a notice, from the same result.
    const a = await pick(page, 'Heatmap');
    expect(await marksSince(page, a.t0)).toEqual([]);
    expect(a.f1.body).toBe('A heatmap needs histogram buckets: series with an le label.');
    expect(a.f1.frames).toBe(0);
    await expect(pv.getByText('Loading')).toHaveCount(0);
  });

  test('E11 a failed load shows the error state', async ({ page }) => {
    await openEditor(page);
    const { pv } = editor(page);
    await previewReady(page);
    await page.evaluate(() => {
      localStorage.setItem('pulsus-dash.stub.failQuery', '1');
    });
    await setQuery(page, 'up');
    await runQuery(page);
    await expect(pv.getByText('Something went wrong')).toBeVisible({ timeout: 5_000 });
    await expect(pv.locator('[data-chart-frame]')).toHaveCount(0);
    await closeByEscape(page);
    await expect(page.locator('[data-panel="p-1"]')).toContainText('Something went wrong');
  });

  test('E12 successive runs: the last wins', async ({ page }) => {
    await openEditor(page, { delayMs: 1500 });
    const { pv } = editor(page);
    await previewReady(page);
    await setQuery(page, `${P1_TEXT} * 2`);
    const first = await runQuery(page);
    // At least 200 ms between the runs: the first's answer (if it were drawn) would come 1.5 s
    // after it, well before the second's.
    await page.waitForTimeout(200);
    await setQuery(page, `${P1_TEXT} * 3`);
    const second = await runQuery(page);
    expect(first.f1.body).toBe('Loading');
    expect(second.f1.body).toBe('Loading');
    const marks = await marksSince(page, first.t0);
    expect(marks.map((m) => m.query)).toEqual([`${P1_TEXT} * 2`, `${P1_TEXT} * 3`]);
    // The first run's answer would have come 1.5 s after it: by then the preview still waits
    // for the second (the first was aborted, so nothing drew it).
    const firstAt = marks[0]?.t ?? 0;
    const secondAt = marks[1]?.t ?? 0;
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(200);
    await page.waitForFunction((t) => performance.now() > t + 1600, firstAt);
    const at = await settled(page);
    if (at.t < secondAt + 1400) {
      expect(at.body).toBe('Loading');
      expect(at.frames).toBe(0);
    }
    await expect(pv.locator('canvas')).toHaveAttribute('aria-label', LABEL['line'] ?? /./, {
      timeout: 5_000,
    });
  });

  for (const from of ['error', 'Logs'] as const) {
    test(`E13 from a message to a cached chart at once: ${from}`, async ({ page }) => {
      await openEditor(page);
      const { pv } = editor(page);
      const line = await reference(page, LABEL['line'] ?? /./);
      if (from === 'error') {
        await page.evaluate(() => {
          localStorage.setItem('pulsus-dash.stub.failQuery', '1');
        });
        await setQuery(page, 'up');
        await runQuery(page);
        await expect(pv.getByText('Something went wrong')).toBeVisible({ timeout: 5_000 });
      } else {
        await pick(page, 'Logs');
        await expect(pv.getByText(LOGS)).toBeVisible();
      }
      await expect(pv.locator('[data-chart-frame]')).toHaveCount(0);
      // Back to the cached chart: the saved query again (its result is fresh), or Line.
      let a: Armed;
      if (from === 'error') {
        await setQuery(page, P1_TEXT);
        a = await runQuery(page);
      } else {
        a = await pick(page, 'Line');
      }
      await expectCachedPick(page, a, 'line', line);
    });
  }

  test('E14 panels: Loading until drawn, never blank', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      type Rec = { id: string; pending: number; inked: boolean }[];
      const records: Rec[] = [];
      Object.assign(window, { __records: records });
      const inkedOf = (c: HTMLCanvasElement | null): boolean => {
        if (c === null || c.width === 0 || c.height === 0) return false;
        const px = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
        if (px === undefined) return false;
        for (let i = 3; i < px.length; i += 4) if ((px[i] ?? 0) > 0) return true;
        return false;
      };
      const tick = (): void => {
        const ro = new ResizeObserver(() => {
          ro.disconnect();
          records.push(
            [...document.querySelectorAll<HTMLElement>('[data-chart-frame]')].map((f) => ({
              id: f.dataset['frameId'] ?? '',
              pending: f.querySelectorAll('[data-chart-pending]').length,
              inked: inkedOf(f.querySelector('canvas')),
            })),
          );
        });
        ro.observe(document.documentElement);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const ready = page.locator('[data-chart-frame][data-frame-ready="true"]');
    const settle = async (n: number): Promise<void> => {
      await expect(ready).toHaveCount(n);
      await expect(page.locator('[data-chart-pending]')).toHaveCount(0);
      await page.evaluate(
        () =>
          new Promise<void>((r) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                r();
              });
            });
          }),
      );
    };
    type Rec = { id: string; pending: number; inked: boolean }[];
    const records = (): Promise<Rec[]> =>
      page.evaluate(() => (window as unknown as { __records: Rec[] }).__records);
    const ids = (): Promise<string[]> =>
      page
        .locator('[data-chart-frame]')
        .evaluateAll((fs) => fs.map((f) => (f as HTMLElement).dataset['frameId'] ?? ''));
    /** Each of `want` shows Loading after `from`, then drawn and inked. */
    const clearedThenDrawn = async (from: number, want: readonly string[]): Promise<void> => {
      const after = (await records()).slice(from);
      for (const id of want) {
        const seq = after.flatMap((r) => r.filter((x) => x.id === id));
        const first = seq.findIndex((x) => x.pending === 1);
        expect(first, `${id} shows Loading after the resize`).toBeGreaterThanOrEqual(0);
        expect(
          seq.slice(first).some((x) => x.pending === 0 && x.inked),
          `${id} drawn after Loading`,
        ).toBe(true);
      }
    };

    await page.goto('/t/demo/board/b-1');
    await page.locator('html[data-shell-ready="true"]').waitFor();
    // On screen: Request rate and Error ratio (Request latency is below the fold, T07-012).
    await settle(2);
    const board = await ids();
    let from = (await records()).length;
    await page.setViewportSize({ width: 1200, height: 900 });
    // The grid takes its new width from a ResizeObserver (#111), so the frames may start Loading a
    // frame after the resize: retry until each has shown Loading and then drawn.
    await expect(async () => {
      await settle(2);
      await clearedThenDrawn(from, board);
    }).toPass({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Full screen: Request rate' }).click();
    const full = page.getByRole('dialog', { name: 'Request rate' });
    await expect(full.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(1);
    await settle(3);
    const fullId = (await full.locator('[data-chart-frame]').getAttribute('data-frame-id')) ?? '';
    from = (await records()).length;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(async () => {
      await settle(3);
      await clearedThenDrawn(from, [...board, fullId]);
    }).toPass({ timeout: 10_000 });

    for (const [i, r] of (await records()).entries()) {
      for (const x of r) {
        expect(x.pending === 1 || x.inked, `record ${String(i)} frame ${x.id} blank`).toBe(true);
      }
    }
  });

  // Appendix C §C.2.

  for (const from of ['Logs', 'error'] as const) {
    test(`E15 fresh dialog on a message: the cached chart in the first frame: ${from}`, async ({
      page,
    }) => {
      await openEditor(page);
      const { pv } = editor(page);
      const line = await reference(page, LABEL['line'] ?? /./);
      const message = from === 'Logs' ? LOGS : 'Something went wrong';
      if (from === 'Logs') {
        await pick(page, 'Logs');
      } else {
        // Two failures: the run, and the refetch of the failed key when the reopened preview
        // mounts on it (TanStack retries an errored query on mount).
        await page.evaluate(() => {
          localStorage.setItem('pulsus-dash.stub.failQuery', '2');
        });
        await setQuery(page, 'up');
        await runQuery(page);
      }
      await expect(pv.getByText(message)).toBeVisible({ timeout: 5_000 });
      await closeByEscape(page);
      await reopen(page);
      await expect(pv.getByText(message)).toBeVisible({ timeout: 5_000 });
      await expect(pv.locator('[data-chart-frame]')).toHaveCount(0);
      await settled(page);
      let a: Armed;
      if (from === 'error') {
        await setQuery(page, P1_TEXT);
        a = await runQuery(page);
      } else {
        a = await pick(page, 'Line');
      }
      await expectCachedPick(page, a, 'line', line);
    });
  }

  test('E16 resize while a message shows: the cached chart in the first frame', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openEditor(page);
    const { pv } = editor(page);
    const line = await reference(page, LABEL['line'] ?? /./);
    await page.setViewportSize({ width: 760, height: 700 });
    await previewReady(page);
    const small = await settled(page);
    expect(small.fp).not.toBe(line);
    const hs = small.hostBox;
    await page.setViewportSize({ width: 1280, height: 900 });
    await previewReady(page);
    await settled(page);
    await pick(page, 'Logs');
    await expect(pv.getByText(LOGS)).toBeVisible();
    await page.setViewportSize({ width: 760, height: 700 });
    await settled(page);
    const a = await pick(page, 'Line');
    expect(await marksSince(page, a.t0)).toEqual([]);
    expect(a.p1.frames).toBe(1);
    expect(a.p1.pending).toBe(0);
    // The chart's own size at this viewport: the legend under it takes the rest of the host (#64).
    expect(a.p1.canvasCss).toEqual(small.canvasCss);
    expect(a.p1.hostBox).toEqual(hs);
    expect(a.p1.fp).toBe(small.fp);
    const inFrame1 = (await draws(page, 'line', a.p1)).filter((x) => a.t0 < x.t && x.t < a.p1.t);
    expect(inFrame1.length).toBeGreaterThan(0);
    expect(a.f2.pending).toBe(0);
    expect(a.f2.fp).toBe(small.fp);
  });
});
