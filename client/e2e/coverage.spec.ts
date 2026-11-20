import { expect, test } from '@playwright/test';
import { keyboardHarness } from './keyboardCoverage.ts';

const strip = (keys: string[]): string[] => keys.map((k) => k.split(' › ')[1] ?? k);

test.describe('keyboard coverage self-test (T05-002)', () => {
  test('Tab collects without operating; Enter and arrows operate', async ({ page }) => {
    await page.setContent(
      '<button>A</button><button>B</button><div role="menu" aria-label="M"><div role="menuitem" tabindex="0">C</div></div>',
    );
    const h = keyboardHarness(page);
    for (let i = 0; i < 3; i++) await h.press('Tab');
    expect(strip(h.uncovered())).toEqual(['button "A"', 'button "B"', 'menuitem "C"']);

    await h.press('Shift+Tab');
    await h.press('Shift+Tab');
    expect(await h.focusName()).toBe('button "A"');
    await h.press('Enter');
    expect(strip(h.uncovered())).toEqual(['button "B"', 'menuitem "C"']);

    await h.press('Tab');
    await h.press('Enter');
    await h.press('Tab');
    await h.press('ArrowDown');
    expect(strip(h.uncovered())).toEqual([]);
  });
});
