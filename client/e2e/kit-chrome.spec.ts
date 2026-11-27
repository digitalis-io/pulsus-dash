/**
 * The visual refresh's chrome (#282 Part 1): materials, shapes, focus rings and motion of the shell
 * and kit (VL-014, VL-016, VL-017, VL-019 as amended; T08-007, T08-019). Colours come from the
 * generated tokens, never literals.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { colour } from '../src/styles/tokens.ts';
import { deleteBoard } from './boardApi.ts';
import { HTTP_BFF } from './bff.ts';
import { createTextBoard, EXPLORE_RESULT, LOGS_RESULT, open, openUserMenu } from './helpers.ts';

type Theme = 'dark' | 'light';
type Rgba = [number, number, number, number];

declare global {
  interface Window {
    __escAt?: number | undefined;
    __goneAt?: number | undefined;
    __goneNextFrame?: boolean | undefined;
    __exitAt?: number | undefined;
    __exitAnims?: number[] | undefined;
    __firstOpacity?: string;
  }
  interface Element {
    __anims?: number[];
  }
}

/** A colour token's hex; an absent key fails the test on an assertion. */
function tok(theme: Theme, key: string): string {
  const v = (colour[theme] as Record<string, string | undefined>)[key];
  expect(v, `${theme}.${key}`).toBeDefined();
  return v ?? '#00000000';
}

function fromHex(hex: string): Rgba {
  const b = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return [b(1), b(3), b(5), hex.length === 9 ? b(7) / 255 : 1];
}

/** A computed `rgb()` / `rgba()` colour. */
function fromCss(v: string): Rgba {
  const m = /^rgba?\(([^)]*)\)$/.exec(v.trim());
  const n = (m?.[1] ?? '')
    .split(/[\s,/]+/)
    .filter((s) => s !== '')
    .map(Number);
  return [n[0] ?? NaN, n[1] ?? NaN, n[2] ?? NaN, n[3] ?? 1];
}

function expectColour(actual: string, hex: string, what: string): void {
  const a = fromCss(actual);
  const e = fromHex(hex);
  const close =
    Math.abs(a[0] - e[0]) <= 1 &&
    Math.abs(a[1] - e[1]) <= 1 &&
    Math.abs(a[2] - e[2]) <= 1 &&
    Math.abs(a[3] - e[3]) * 255 <= 1.5;
  expect(close, `${what}: ${actual} ≈ ${hex}`).toBe(true);
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function css(l: Locator, prop: string): Promise<string> {
  return l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
}

async function backdrop(l: Locator): Promise<string> {
  return l.evaluate((e) => {
    const s = getComputedStyle(e);
    const v = s.getPropertyValue('backdrop-filter');
    return v !== '' ? v : s.getPropertyValue('-webkit-backdrop-filter');
  });
}

/** The system Highlight colour, as the page resolves it now. */
async function highlight(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = document.createElement('div');
    d.style.backgroundColor = 'Highlight';
    document.body.append(d);
    const v = getComputedStyle(d).backgroundColor;
    d.remove();
    return v;
  });
}

async function forcedActive(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia('(forced-colors: active)').matches);
}

async function setLight(page: Page): Promise<void> {
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
}

const userPopover = (page: Page): Locator => page.locator('[data-trigger="MenuTrigger"]');

/**
 * Moves focus to `target` with the keyboard: focus lands on it, Shift+Tab leaves it and Tab comes
 * back, so the focus is a keyboard focus (`:focus-visible`, React Aria's `data-focus-visible`).
 */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

/** Under forced colours, `l`'s background settles on the system Highlight (never transparent). */
async function expectHighlight(page: Page, l: Locator, what: string): Promise<void> {
  const want = await highlight(page);
  expect(want, 'Highlight').not.toBe(TRANSPARENT);
  // Colours transition over `motion.quick`: poll until the forced colour has settled.
  await expect.poll(() => css(l, 'background-color'), { message: what }).toBe(want);
}

async function minBox(l: Locator, what: string): Promise<void> {
  const b = await l.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b?.width ?? 0, `${what} width`).toBeGreaterThanOrEqual(24);
  expect(b?.height ?? 0, `${what} height`).toBeGreaterThanOrEqual(24);
}

async function expectRing(l: Locator, theme: Theme, offset: string, what: string): Promise<void> {
  expect(await css(l, 'outline-style'), `${what} outline-style`).toBe('solid');
  expect(await css(l, 'outline-width'), `${what} outline-width`).toBe('3px');
  expect(await css(l, 'outline-offset'), `${what} outline-offset`).toBe(offset);
  expectColour(await css(l, 'outline-color'), tok(theme, 'focus'), `${what} outline-color`);
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });

/** b-1 → Edit board → Panel menu: Request rate → Edit panel. */
async function openPanelEditor(page: Page): Promise<Locator> {
  await open(page, '/t/demo/board/b-1');
  await page.getByRole('button', { name: 'Edit board' }).click();
  await page.getByRole('button', { name: 'Panel menu: Request rate' }).click();
  await page.getByRole('menuitem', { name: 'Edit panel' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit panel' });
  await editor.waitFor();
  return editor;
}

test.describe('kit chrome (#282)', () => {
  test('e2e:kit-materials', async ({ page, browserName }) => {
    for (const theme of ['dark', 'light'] as const) {
      await open(page, '/t/demo/boards');
      if (theme === 'light') await setLight(page);
      const header = page.getByRole('banner');
      await openUserMenu(page);
      const pop = userPopover(page);
      // Every engine can blur: the material is required in all three. A browser without the
      // reduced-transparency query (Firefox, WebKit) keeps it (VL-017 as amended).
      for (const [name, l, material] of [
        ['header', header, 'material-bar'],
        ['popover', pop, 'material-menu'],
      ] as const) {
        expect(await backdrop(l), `${browserName} ${theme} ${name} filter`).toContain('blur(24px)');
        expectColour(await css(l, 'background-color'), tok(theme, material), name);
      }
      expect(await css(pop, 'border-top-left-radius')).toBe('10px');
      expect(await css(pop, 'box-shadow')).not.toBe('none');
      await page.keyboard.press('Escape');
    }

    // The last leg left the light theme chosen.
    const theme = (): Theme => 'light';
    const opaque = async (what: string): Promise<void> => {
      await open(page, '/t/demo/boards');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme());
      await openUserMenu(page);
      for (const [name, l] of [
        ['header', page.getByRole('banner')],
        ['popover', userPopover(page)],
      ] as const) {
        const f = await backdrop(l);
        expect(f === 'none' || f === '', `${what} ${name} filter: ${f}`).toBe(true);
        const bg = await css(l, 'background-color');
        // Forced colours repaint the background in a system colour; it stays opaque.
        if (what === 'forced colours') expect(fromCss(bg)[3], `${what} ${name} alpha`).toBe(1);
        else expectColour(bg, tok(theme(), 'surface-1'), `${what} ${name}`);
      }
    };
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
      });
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches),
        'reduce emulated',
      ).toBe(true);
      await opaque('reduced transparency');
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await cdp.detach();
    }
    await page.emulateMedia({ forcedColors: 'active' });
    if (await forcedActive(page)) await opaque('forced colours');
  });

  test('e2e:kit-shapes', async ({ page }) => {
    test.setTimeout(120_000);
    const theme: Theme = 'dark';
    await open(page, '/t/demo/boards');
    expect(await css(page.getByRole('heading', { level: 1 }), 'font-size')).toBe('16px');
    await page.getByRole('button', { name: 'New board' }).click();
    const dialog = page.getByRole('dialog', { name: 'New board' });
    await dialog.waitFor();
    for (const name of ['Create', 'Cancel']) {
      const b = dialog.getByRole('button', { name, exact: true });
      expect(await css(b, 'border-top-left-radius'), `${name} radius`).toBe('9999px');
      expect((await b.boundingBox())?.height ?? 0, `${name} height`).toBeCloseTo(28, 1);
    }
    const field = dialog.getByRole('textbox', { name: 'Name' });
    expect(await css(field, 'border-top-left-radius')).toBe('6px');
    await minBox(field, 'text field');
    const modal = dialog.locator('xpath=..');
    expect(await css(modal, 'border-top-left-radius')).toBe('14px');
    expect(await css(modal, 'box-shadow')).not.toBe('none');
    expect(await css(modal, 'box-shadow')).not.toBe('');
    await page.keyboard.press('Escape');

    // The sidebar's current row, expanded then collapsed.
    const current = async (state: string): Promise<void> => {
      const row = nav(page).locator('a[aria-current="page"]');
      await expect(row).toHaveCount(1);
      expectColour(await css(row, 'background-color'), tok(theme, 'accent-fill'), `${state} row`);
      expect(await css(row, 'box-shadow'), `${state} row shadow`).not.toContain('inset');
      const icon = row.locator('span').first();
      expectColour(await css(icon, 'color'), tok(theme, 'text-on-accent'), `${state} icon`);
      if (state === 'expanded') {
        const label = row.locator('span').nth(1);
        expectColour(await css(label, 'color'), tok(theme, 'text-on-accent'), `${state} label`);
      }
      await page.emulateMedia({ forcedColors: 'active' });
      if (await forcedActive(page)) await expectHighlight(page, row, `${state} forced row`);
      await page.emulateMedia({ forcedColors: 'none' });
    };
    await current('expanded');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await current('collapsed');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();

    // Explore's result-card segmented control.
    await open(page, EXPLORE_RESULT);
    const group = page.getByRole('radiogroup', { name: 'Visualisation' });
    await group.waitFor();
    expect(await css(group, 'border-top-left-radius')).toBe('9999px');
    const radios = group.getByRole('radio');
    const n = await radios.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const r = radios.nth(i);
      await minBox(r, `segment ${String(i)}`);
      if ((await r.getAttribute('aria-checked')) === 'true') {
        expectColour(await css(r, 'background-color'), tok(theme, 'accent-fill'), 'selected');
        expectColour(await css(r, 'color'), tok(theme, 'text-on-accent'), 'selected text');
      } else {
        expect(await css(r, 'background-color'), `segment ${String(i)}`).toBe(TRANSPARENT);
      }
    }
    await page.emulateMedia({ forcedColors: 'active' });
    if (await forcedActive(page)) {
      await expectHighlight(page, group.locator('[aria-checked="true"]'), 'forced segment');
    }
    await page.emulateMedia({ forcedColors: 'none' });

    // The log stream's Checkbox label row.
    await open(page, LOGS_RESULT);
    const wrap = page.getByRole('checkbox', { name: 'Wrap lines' });
    await wrap.waitFor({ state: 'attached' });
    await minBox(wrap.locator('xpath=ancestor::label[1]'), 'log-stream Checkbox label');

    // The panel editor's Select trigger.
    const editor = await openPanelEditor(page);
    await minBox(editor.getByRole('button', { name: /Visualisation$/ }), 'Select trigger');
  });

  test('e2e:kit-focus', async ({ page }) => {
    test.setTimeout(120_000);
    const theme: Theme = 'dark';
    await open(page, '/t/demo/boards');
    const newBoard = page.getByRole('button', { name: 'New board' });
    await tabTo(page, newBoard);
    await expectRing(newBoard, theme, '1px', 'Button');
    await page.keyboard.press('Enter');
    const field = page
      .getByRole('dialog', { name: 'New board' })
      .getByRole('textbox', { name: 'Name' });
    await expect(field).toBeFocused();
    await expectRing(field, theme, '0px', 'text field');
    await page.keyboard.press('Escape');

    // The user menu by keyboard: the focused item is accent-filled.
    const avatar = page.getByRole('button', { name: 'AA, user menu: Ada Admin', exact: true });
    await avatar.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'AA, user menu: Ada Admin', exact: true });
    await menu.waitFor();
    await page.keyboard.press('ArrowDown');
    const item = menu.locator('[data-focused]');
    await expect(item).toHaveCount(1);
    expectColour(await css(item, 'background-color'), tok(theme, 'accent-fill'), 'menu item');
    expectColour(await css(item, 'color'), tok(theme, 'text-on-accent'), 'menu item text');
    await page.emulateMedia({ forcedColors: 'active' });
    if (await forcedActive(page)) await expectHighlight(page, item, 'forced menu item');
    await page.emulateMedia({ forcedColors: 'none' });
    await page.keyboard.press('Escape');

    await open(page, EXPLORE_RESULT);
    const group = page.getByRole('radiogroup', { name: 'Visualisation' });
    await group.waitFor();
    await tabTo(page, group.locator('[aria-checked="true"]'));
    const seg = group.locator('[data-focus-visible]');
    await expect(seg).toHaveCount(1);
    await expectRing(seg, theme, '1px', 'segmented item');

    await open(page, LOGS_RESULT);
    const wrap = page.getByRole('checkbox', { name: 'Wrap lines' });
    await wrap.waitFor({ state: 'attached' });
    await tabTo(page, wrap);
    const box = wrap
      .locator('xpath=ancestor::label[1]')
      .locator('xpath=./span[not(.//input)]')
      .first();
    await expectRing(box, theme, '1px', 'Checkbox box');

    const editor = await openPanelEditor(page);
    const trigger = editor.getByRole('button', { name: /Visualisation$/ });
    await tabTo(page, trigger);
    await expectRing(trigger, theme, '0px', 'Select trigger');
  });

  test('e2e:kit-motion', async ({ page, browserName }) => {
    await page.addInitScript(() => {
      document.addEventListener(
        'animationstart',
        (e) => {
          const el = e.target as Element;
          if (el.matches('[data-trigger="MenuTrigger"][data-exiting]')) {
            window.__exitAt = performance.now();
            window.__exitAnims = el
              .getAnimations()
              .map((a) => Number(a.effect?.getTiming().duration ?? NaN));
          }
          el.__anims ??= el
            .getAnimations()
            .map((a) => Number(a.effect?.getTiming().duration ?? NaN));
        },
        true,
      );
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'Escape') return;
          window.__escAt = performance.now();
          const pop = document.querySelector('[data-trigger="MenuTrigger"]');
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.__goneNextFrame = pop === null || !pop.isConnected;
            });
          });
        },
        true,
      );
      const watch = (): void => {
        new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.removedNodes) {
              if (!(n instanceof Element)) continue;
              if (
                n.matches('[data-trigger="MenuTrigger"]') ||
                n.querySelector('[data-trigger="MenuTrigger"]')
              )
                window.__goneAt = performance.now();
            }
            for (const n of m.addedNodes) {
              if (!(n instanceof Element)) continue;
              const pop = n.matches('[data-trigger="MenuTrigger"]')
                ? n
                : n.querySelector('[data-trigger="MenuTrigger"]');
              if (pop !== null)
                requestAnimationFrame(() => {
                  window.__firstOpacity = getComputedStyle(pop).opacity;
                });
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      };
      if ((document.body as HTMLElement | null) !== null) watch();
      else document.addEventListener('DOMContentLoaded', watch);
    });

    const run = async (reduce: boolean): Promise<void> => {
      await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
      await open(page, '/t/demo/boards');
      await openUserMenu(page);
      const pop = userPopover(page);
      if (reduce) {
        expect(await pop.evaluate((e) => e.getAnimations().length)).toBe(0);
        await expect.poll(() => page.evaluate(() => window.__firstOpacity)).toBe('1');
      } else {
        await expect.poll(() => pop.evaluate((e) => e.__anims ?? null)).toEqual([150]);
      }
      expect(await pop.evaluate((e) => e.__anims ?? [])).toEqual(reduce ? [] : [150]);
      await page.evaluate(() => {
        window.__escAt = undefined;
        window.__goneAt = undefined;
        window.__goneNextFrame = undefined;
        window.__exitAt = undefined;
        window.__exitAnims = undefined;
      });
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      if (reduce) {
        await expect.poll(() => page.evaluate(() => window.__goneNextFrame)).toBe(true);
      } else {
        // The exit is one 100 ms fade, and the popover is gone 150 ms after it starts (measured
        // from the fade, not the key press: a loaded host delays the key's handling, not the exit).
        // WebKit unmounts at once: React Aria finds no exit animation yet when it looks.
        const exit = await page.evaluate(() => window.__exitAnims ?? null);
        if (browserName === 'webkit' && exit === null) {
          const gone = await page.evaluate(
            () => (window.__goneAt ?? NaN) - (window.__escAt ?? NaN),
          );
          expect(gone, 'popover gone after Escape (ms)').toBeLessThanOrEqual(150);
        } else {
          expect(exit).toEqual([100]);
          const gone = await page.evaluate(
            () => (window.__goneAt ?? NaN) - (window.__exitAt ?? NaN),
          );
          expect(gone, 'popover gone after its exit starts (ms)').toBeLessThanOrEqual(150);
        }
      }

      await page.getByRole('button', { name: 'New board' }).click();
      const dialog = page.getByRole('dialog', { name: 'New board' });
      await dialog.waitFor();
      const modal = dialog.locator('xpath=..');
      const overlay = modal.locator('xpath=..');
      for (const [name, l] of [
        ['dialog', modal],
        ['overlay', overlay],
      ] as const) {
        if (reduce) {
          expect(await l.evaluate((e) => e.getAnimations().length), name).toBe(0);
          expect(await l.evaluate((e) => e.__anims ?? []), name).toEqual([]);
        } else {
          await expect.poll(() => l.evaluate((e) => e.__anims ?? null), name).toEqual([200]);
        }
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    };
    await run(false);
    await run(true);
  });
});

// Boards made through the API are served by the http build (the stub build has its seeded data).
test.describe('kit chrome on the http build (#282)', () => {
  test.use({ baseURL: HTTP_BFF });

  test('e2e:kit-shapes: the text widget TextArea', async ({ page, request, browserName }, info) => {
    test.setTimeout(120_000);
    // A text widget's TextArea: rows tall, vertical resize, and a drag grows it.
    const uid = await createTextBoard(
      request,
      `kit-shapes ${info.project.name} ${String(Date.now())}`,
      [{ id: 'p-1', title: 'Notes', content: 'One', grid: [0, 0, 6, 8] }],
    );
    try {
      await open(page, `/t/demo/board/${uid}`);
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: 'Panel menu: Notes' }).click();
      await page.getByRole('menuitem', { name: 'Edit panel' }).click();
      const text = page.getByRole('dialog', { name: 'Edit text panel' });
      const area = text.getByRole('textbox', { name: 'Content' });
      await area.fill('1\n2\n3\n4\n5');
      expect(await css(area, 'resize')).toBe('vertical');
      const lh = parseFloat(await css(area, 'line-height'));
      await area.scrollIntoViewIfNeeded();
      const b = await area.boundingBox();
      if (b === null) throw new Error('the text area has no box');
      expect(b.height).toBeGreaterThanOrEqual(3 * lh);
      // WebKit's resize handle does not take synthesised pointer drags.
      if (browserName === 'webkit') return;
      await page.mouse.move(b.x + b.width - 3, b.y + b.height - 3);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width - 3, b.y + b.height + 60, { steps: 6 });
      await page.mouse.up();
      expect((await area.boundingBox())?.height ?? 0).toBeGreaterThan(b.height);
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
