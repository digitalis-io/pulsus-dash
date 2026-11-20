import { expect, test } from '@playwright/test';
import { open, ORIGIN } from './helpers.ts';

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
    // Engines differ in quoting the family name in computed styles.
    const first = (f: string): string => (f.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
    expect(first(h1)).toBe('Inter Variable');
    const summary = await page
      .getByText(/^Showing /)
      .evaluate((e) => getComputedStyle(e).fontFamily);
    expect(first(summary)).toBe('JetBrains Mono Variable');
  });
});
