/**
 * The keyboard script's steps (plan #57 §5.3; plan #61 Part B Appendix B-A §A.5): focus by Tab,
 * operate, menus, text replacement, and the `drain` and `shellAfter` coverage helpers. Input goes
 * only through the harness's `press` and `type` (ESLint bans other input in the keyboard files).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { KeyboardHarness } from './keyboardCoverage.ts';

export type Target = string | RegExp;

function matches(focus: string, target: Target): boolean {
  return typeof target === 'string' ? focus === target : target.test(focus);
}

export const TRIGGER = 'button "<time range>"';
const POPOVER = '[data-trigger]:not([data-trigger="TooltipTrigger"])';

/** The script's steps over one page and harness. Input only through the harness's press and type. */
export function script(page: Page, h: KeyboardHarness) {
  const { press, type } = h;
  // Leaving a board with unsaved changes asks through `beforeunload` (the app opens no other browser
  // dialog); a `goto` to the next state accepts it (dismissed, the navigation would never finish).
  page.on('dialog', (d) => {
    void d.accept();
  });

  /** Navigates (not input): the state the next rows start from. */
  async function goto(url: string): Promise<void> {
    await page.goto(url, { timeout: 30_000 });
    await ready();
  }

  async function ready(): Promise<void> {
    const path = new URL(page.url()).pathname;
    if (path.startsWith('/t/')) await page.locator('html[data-shell-ready="true"]').waitFor();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/^Loading/);
  }

  /**
   * A check of whether `target` has focus. A key of a control on the page is checked on its element
   * (one round trip per key press); a pattern, or a key not on the page yet, by the focused
   * control's name.
   */
  async function focusCheck(target: Target): Promise<() => Promise<boolean>> {
    const byName = async (): Promise<boolean> => matches(await h.focusName(), target);
    if (typeof target !== 'string') return byName;
    const { scope } = await scopes();
    const el = resolve(scope, target);
    if ((await el.count()) === 0) return byName;
    return () =>
      el
        .evaluate(
          (e) => {
            // Into open shadow roots: the editor's textbox is focused inside its host (plan #63 R2).
            let a = document.activeElement;
            while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
            return a !== null && (e === a || e.contains(a));
          },
          null,
          {
            timeout: 2_000,
          },
        )
        .catch(byName);
  }

  /**
   * Tabs (forwards, or backwards with `back`) until the focused control matches; if `max` presses
   * do not reach it, goes the other way (twice as far: back past the start).
   */
  async function focus(target: Target, o: { back?: boolean; max?: number } = {}): Promise<void> {
    const max = o.max ?? 45;
    const at = await focusCheck(target);
    for (const [back, n] of [
      [o.back === true, max],
      [o.back !== true, 2 * max],
    ] as const) {
      for (let i = 0; i <= n; i++) {
        if (await at()) return;
        await press(back ? 'Shift+Tab' : 'Tab');
      }
    }
    throw new Error(
      `cannot reach ${String(target)} by keyboard; focus is on ${await h.focusName()}`,
    );
  }

  /** Focuses `target` and presses `key` on it. */
  async function on(target: Target, key = 'Enter', o: { back?: boolean } = {}): Promise<void> {
    await focus(target, o);
    await press(key);
  }

  function path(): string {
    return new URL(page.url()).pathname;
  }

  function search(): Record<string, string> {
    return Object.fromEntries(new URL(page.url()).searchParams);
  }

  function dialog() {
    return page.getByRole('dialog', { name: 'Time range' });
  }

  /** Opens the time range dialog; focus lands in the Quick ranges list box. */
  async function openPicker(): Promise<void> {
    await on(TRIGGER);
    const list = dialog().getByRole('listbox', { name: 'Quick ranges' });
    await expect
      .poll(() => list.evaluate((l) => l.contains(document.activeElement)).catch(() => false))
      .toBe(true);
  }

  /** Operates, with Enter, every link of the current page not yet operated here (Back after each). */
  async function everyLink(
    url: string,
    filter: (key: string) => boolean = () => true,
  ): Promise<void> {
    for (let guard = 0; guard < 40; guard++) {
      await goto(url);
      await press('Tab');
      const link = (await h.pendingHere()).find((k) => k.startsWith('link ') && filter(k));
      if (link === undefined) return;
      await on(link);
      await ready();
    }
    throw new Error(`links on ${url} keep changing`);
  }

  async function quickRange(i: number): Promise<void> {
    await openPicker();
    await press('Home');
    for (let k = 0; k < i; k++) await press('ArrowDown');
    await press('Enter');
    await expect(dialog()).toBeHidden();
  }

  /** Opens a menu from its button and chooses the item `steps` below the first. */
  async function menuItem(button: Target, steps: number): Promise<void> {
    await on(button);
    await expect(page.getByRole('menu')).toBeVisible();
    await press('Home');
    for (let k = 0; k < steps; k++) await press('ArrowDown');
    await press('Enter');
  }

  /** Replaces a field's text by keyboard: select all, then type. */
  async function replaceText(target: Target, text: string): Promise<void> {
    await focus(target);
    await press('ControlOrMeta+A');
    await type(text);
  }

  /** The harness scope (body, or the top overlay) and the drained region (main, or the overlay). */
  async function scopes(): Promise<{ scope: Locator; region: Locator }> {
    const kind = await page.evaluate((popover) => {
      const roots = [...document.querySelectorAll(`${popover}, [role="dialog"]`)].filter(
        (el) =>
          el.closest('#root') === null && el.closest('[data-trigger="TooltipTrigger"]') === null,
      );
      const top = roots.at(-1);
      return top === undefined ? 'none' : top.matches(popover) ? 'popover' : 'modal';
    }, POPOVER);
    if (kind === 'none') return { scope: page.locator('body'), region: page.getByRole('main') };
    const overlay =
      kind === 'popover' ? page.locator(POPOVER).last() : page.locator('[role="dialog"]').last();
    return { scope: overlay, region: overlay };
  }

  /**
   * The element of a `role "name" #n` key in `scope`. Keys hold the accessible name as it is, so a
   * name may itself contain quotes (a legend row's series name, `m{job="a"}`; #64 Part B).
   */
  function resolve(scope: Locator, key: string): Locator {
    const m = /^([a-z]+) "(.*)"(?: #(\d+))?$/s.exec(key);
    if (m === null) throw new Error(`bad key ${key}`);
    const name = m[2] ?? '';
    return scope
      .getByRole(m[1] as Parameters<Page['getByRole']>[0], { name, exact: true })
      .nth(Number(m[3] ?? '1') - 1);
  }

  async function inside(region: Locator, el: Locator): Promise<boolean> {
    if ((await el.count()) === 0) return false;
    const handle = await el.elementHandle();
    return region.evaluate((r, e) => r.contains(e), handle);
  }

  /**
   * Tabs to the control of `key` (by its element, one cheap check per key press). From the start of
   * a page it first takes the skip link (Tab, Enter: focus moves to `main`), so a drain of a page
   * body does not tab through the sidebar and the header each time.
   */
  async function reach(name: string, key: string): Promise<void> {
    const { scope, region } = await scopes();
    // Re-resolved on each check: the lazy Edit grid replaces its fallback's elements.
    const at = await focusCheck(key);
    if (await at()) return;
    const main = page.getByRole('main');
    const inMain = await inside(main, resolve(scope, key));
    // Only from the start of the page (nothing focused yet, as after a `goto`).
    const atStart = await page.evaluate(
      () => document.activeElement === null || document.activeElement === document.body,
    );
    if (inMain && atStart && (await region.evaluate((r) => r.tagName === 'MAIN'))) {
      // Tab lands on the skip link only when the page's focus starting point is its top.
      await press('Tab');
      if ((await h.focusName()) === 'link "Skip to main content"') await press('Enter');
    }
    // A radio that is not its group's tab stop (a segmented control, #198 Part 3a): Tab reaches the
    // group, and the arrow keys move within it.
    const target = resolve(scope, key);
    const inItsGroup = async (): Promise<boolean> =>
      key.startsWith('radio ') &&
      (await target.count()) > 0 &&
      target.evaluate((t) => {
        const group = t.closest('[role="radiogroup"]');
        const a = document.activeElement;
        return group !== null && a !== null && a !== t && group.contains(a);
      });
    for (const [back, n] of [
      [false, 90],
      [true, 180],
    ] as const) {
      for (let i = 0; i <= n; i++) {
        if (await at()) return;
        if (await inItsGroup()) {
          for (const arrow of ['ArrowRight', 'ArrowLeft']) {
            for (let j = 0; j < 8; j++) {
              await press(arrow);
              if (await at()) return;
            }
          }
        }
        await press(back ? 'Shift+Tab' : 'Tab');
      }
    }
    throw new Error(`drain ${name}: cannot reach ${key}; focus is on ${await h.focusName()}`);
  }

  /** The operating key of each role that can occur in a drained region (Appendix B-A §A.5). */
  async function operate(name: string, key: string): Promise<void> {
    const role = key.split(' ')[0] ?? '';
    if (role === 'menuitem' || role === 'option') {
      // Menus and list boxes move focus with the arrow keys; Tab leaves them.
      await press('Home');
      for (let i = 0; i < 40 && (await h.focusName()) !== key; i++) await press('ArrowDown');
      if ((await h.focusName()) !== key) throw new Error(`drain ${name}: cannot reach ${key}`);
    } else {
      await reach(name, key);
    }
    if (['link', 'button', 'menuitem', 'option'].includes(role)) await press('Enter');
    else if (['checkbox', 'switch', 'radio'].includes(role)) await press('Space');
    else if (role === 'slider') {
      await press('End');
      await press('Escape');
    } else if (role === 'textbox') await press('End');
    else if (role === 'combobox') {
      // The metric picker (plan #64): its list opens on focus; ArrowDown moves in it, Escape closes.
      await press('ArrowDown');
      await press('Escape');
    } else throw new Error(`drain ${name}: no operation for ${key}`);
  }

  /** The first pending control inside the current state's region, if any. */
  /** The first pending control of the region; `only` narrows the page's region (no overlay). */
  async function nextPending(only?: Locator): Promise<string | undefined> {
    const s0 = await scopes();
    const region =
      only !== undefined && (await s0.region.evaluate((r) => r.tagName === 'MAIN'))
        ? only
        : s0.region;
    for (const key of await h.pendingHere()) {
      if (await inside(region, resolve(s0.scope, key))) return key;
    }
    return undefined;
  }

  /**
   * Operates every pending control of one state's region. Each round enters the state afresh and
   * operates its first pending control; while an operation leaves the route, the overlay and the
   * URL as they were, the next pending control is operated from there (the state is the same), so
   * not every control costs a replay. The drain ends only when a fresh entry finds nothing pending.
   * When an operation opens an overlay on the same route (a dialog, menu or list box), that overlay
   * is drained next, entered by the same replay plus that operation (two levels deep at most).
   */
  async function drain(
    name: string,
    enter: () => Promise<void>,
    depth = 0,
    /** At the top level, only this part of the page (a panel copy, plan #64). */
    only?: Locator,
  ): Promise<void> {
    for (let round = 0; round < 80; round++) {
      await enter();
      let next = await nextPending(only);
      if (next === undefined) return;
      while (next !== undefined) {
        const before = await h.state();
        const url = page.url();
        const key = next;
        await operate(name, key);
        const after = await h.state();
        if (after !== before || page.url() !== url) {
          const sameRoute = before.split(' + ')[0] === after.split(' + ')[0];
          const overlay = sameRoute && !after.endsWith(' + none');
          if (depth < 2 && overlay) {
            await drain(
              `${name} › ${key}`,
              async () => {
                await enter();
                await operate(name, key);
              },
              depth + 1,
            );
          } else if (overlay && page.url() === url) {
            // An overlay past the depth limit is not drained: close it, and go on from here when
            // that restores the state (a select's list box in the panel editor, #64 Part B), so
            // it costs no replay.
            await press('Escape');
            if ((await h.state()) === before) {
              next = await nextPending(only);
              continue;
            }
          }
          break;
        }
        next = await nextPending(only);
      }
    }
    throw new Error(`drain ${name}: still pending ${(await h.pendingHere()).join(', ')}`);
  }

  /** Link keys of the sidebar and the page body now. */
  async function linkKeys(): Promise<string[]> {
    const { scope } = await scopes();
    const nav = page.getByRole('navigation', { name: 'Main' });
    const main = page.getByRole('main');
    const out: string[] = [];
    for (const key of await h.pendingHere()) {
      if (!key.startsWith('link ')) continue;
      const el = resolve(scope, key);
      if ((await inside(nav, el)) || (await inside(main, el))) out.push(key);
    }
    return out;
  }

  /**
   * Operates, in this page session, each link that an action added (Appendix B-A §A.5, review r3):
   * Enter on it, then back with `back` (keyboard only).
   */
  async function shellAfter(before: readonly string[], back: () => Promise<void>): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      const key = (await linkKeys()).find((k) => !before.includes(k));
      if (key === undefined) return;
      const state = await h.state();
      await on(key);
      expect([...h.operated()]).toContain(`${state} › ${key}`);
      await ready();
      await back();
      await ready();
    }
    throw new Error('shellAfter: links keep appearing');
  }

  return {
    page,
    h,
    goto,
    ready,
    focus,
    on,
    path,
    search,
    dialog,
    openPicker,
    everyLink,
    quickRange,
    menuItem,
    replaceText,
    drain,
    shellAfter,
    linkKeys,
  };
}

export type Script = ReturnType<typeof script>;
