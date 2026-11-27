import { expect, test, type Page } from '@playwright/test';
import { STAT_FONT } from '../src/engine/canvas2d/layout.ts';
import { frame, galleryReady, GALLERY_URL, open, ORIGIN, T } from './helpers.ts';

declare global {
  interface Window {
    __fontDraws?: { frame: string | null; t: number }[];
    __interAt?: number;
  }
}

// Engines differ in quoting the family name in computed styles.
const first = (f: string): string => (f.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');

/** Leg B (#282, ADR-0035): an Apple platform, as `navigator` reports it. */
async function asApple(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true });
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
  });
}

test.describe('e2e:font-origin', () => {
  test('fonts are self-hosted and applied', async ({ page }) => {
    const fonts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'font') fonts.push(r.url());
    });
    await open(page, '/t/demo/board/b-1');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.fonts.check('13px "Inter Variable"') &&
            document.fonts.check('13px "JetBrains Mono Variable"'),
        ),
      )
      .toBe(true);
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(new URL(f).origin).toBe(ORIGIN);
    const h1 = await page
      .getByRole('heading', { level: 1 })
      .evaluate((e) => getComputedStyle(e).fontFamily);
    expect(first(h1)).toBe('Inter Variable');
    const summary = await page
      .getByText(/^Showing /)
      .evaluate((e) => getComputedStyle(e).fontFamily);
    expect(first(summary)).toBe('JetBrains Mono Variable');
  });

  test('Apple platforms: the system UI face; data stays JetBrains Mono, fonts same-origin', async ({
    page,
  }) => {
    await asApple(page);
    const fonts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'font') fonts.push(r.url());
    });
    await open(page, '/t/demo/board/b-1');
    await expect(page.locator('html')).toHaveAttribute('data-platform', 'apple');
    const h1 = await page
      .getByRole('heading', { level: 1 })
      .evaluate((e) => getComputedStyle(e).fontFamily);
    expect(first(h1)).toBe('-apple-system');
    const summary = await page
      .getByText(/^Showing /)
      .evaluate((e) => getComputedStyle(e).fontFamily);
    expect(first(summary)).toBe('JetBrains Mono Variable');
    for (const f of fonts) expect(new URL(f).origin).toBe(ORIGIN);
  });

  test('Apple platforms: canvas text is Inter, redrawn once the font arrives', async ({ page }) => {
    await asApple(page);
    await page.addInitScript(() => {
      const draws: { frame: string | null; t: number }[] = [];
      window.__fontDraws = draws;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name !== 'chart-draw') continue;
          const d = (e as PerformanceMeasure).detail as { frame?: string | null } | null;
          draws.push({ frame: d?.frame ?? null, t: e.startTime });
        }
      }).observe({ type: 'measure' });
    });
    const inter: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/*inter-latin-wght-normal*', async (route) => {
      inter.push(route.request().url());
      await held;
      await route.continue();
    });
    await page.clock.setFixedTime(T);
    await page.goto(GALLERY_URL);
    await expect(page.locator('html')).toHaveAttribute('data-platform', 'apple');
    const stat = frame(page, 'stat');
    await expect(stat).toHaveAttribute('data-frame-ready', 'true');
    const id = (await stat.getAttribute('data-frame-id')) ?? '';
    expect(id).not.toBe('');
    const before = await stat.screenshot();
    await page.evaluate((f) => {
      void document.fonts.load(f).then(() => {
        window.__interAt = performance.now();
      });
    }, STAT_FONT);
    release();
    await expect
      .poll(() =>
        page.evaluate((frameId) => {
          const at = window.__interAt;
          return (
            at !== undefined &&
            (window.__fontDraws ?? []).some((d) => d.frame === frameId && d.t >= at)
          );
        }, id),
      )
      .toBe(true);
    await galleryReady(page);
    expect(await page.evaluate((f) => document.fonts.check(f), STAT_FONT)).toBe(true);
    expect(inter.length).toBeGreaterThan(0);
    for (const u of inter) expect(new URL(u).origin).toBe(ORIGIN);
    const after = await stat.screenshot();
    expect(after.equals(before), 'the stat redrew in Inter').toBe(false);
  });
});
