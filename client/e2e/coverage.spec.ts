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

test.describe('keyboard coverage: only library screen-reader-only controls are skipped', () => {
  test('a visible empty labelled button stays uncovered until operated', async ({ page }) => {
    await page.setContent(
      '<button aria-label="Close" tabindex="-1"></button>' +
        '<div style="clip-path: inset(50%); position: absolute; width: 1px; height: 1px; overflow: hidden">' +
        '<button aria-label="Dismiss" tabindex="-1"></button></div>' +
        '<button>Other</button>',
    );
    const h = keyboardHarness(page);
    await h.press('Tab');
    expect(strip(h.uncovered())).toEqual(['button "Close"', 'button "Other"']);
    await page.getByRole('button', { name: 'Close' }).focus();
    await h.press('Enter');
    expect(strip(h.uncovered())).toEqual(['button "Other"']);
  });
});

test.describe('keyboard coverage: panel copies made by the traversal (plan #64)', () => {
  test("a duplicate's controls are operated once; its own copies end the traversal", async ({
    page,
  }) => {
    // Duplicate appends a panel `<title> (copy)` with a Duplicate of its own, as the board does.
    await page.setContent(
      '<main id="m"><section data-panel="p-1"><button>Duplicate: A</button></section>' +
        '<section data-panel="p-9"><button>Rename B (copy)</button></section></main>' +
        '<script>let n = 1; document.addEventListener("click", (e) => {' +
        ' const b = e.target.closest("button"); if (!b || !b.textContent.startsWith("Duplicate: ")) return;' +
        ' n += 1; const s = document.createElement("section"); s.dataset.panel = "p-" + n;' +
        ' const c = document.createElement("button"); c.textContent = b.textContent + " (copy)";' +
        ' s.append(c); document.getElementById("m").append(s); });</script>',
    );
    const h = keyboardHarness(page);
    await h.press('Tab');
    await h.press('Enter');
    // The first copy is traversed: its control is collected, and so is a user's "(copy)" name.
    expect(strip(h.uncovered())).toEqual([
      'button "Duplicate: A (copy)"',
      'button "Rename B (copy)"',
    ]);
    await page.getByRole('button', { name: 'Duplicate: A (copy)' }).focus();
    await h.press('Enter');
    // The copy's own copy is not traversed again: nothing new to operate.
    expect(strip(h.uncovered())).toEqual(['button "Rename B (copy)"']);
    expect([...h.collected()].some((k) => k.includes('(copy) (copy)'))).toBe(false);
    await page.getByRole('button', { name: 'Rename B (copy)' }).focus();
    await h.press('Enter');
    expect(strip(h.uncovered())).toEqual([]);
  });
});

test.describe('keyboard coverage: the none scope is #root (#130)', () => {
  test('a control outside #root is not collected under + none', async ({ page }) => {
    // React Aria portals every overlay outside #root; with none open, only #root is the page.
    await page.setContent('<div id="root"><button>A</button></div><button>Out</button>');
    const h = keyboardHarness(page);
    await h.press('Tab');
    await h.press('Tab');
    expect(strip([...h.collected()])).toEqual(['button "A"']);
  });
});
