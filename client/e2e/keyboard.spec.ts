/**
 * `e2e:a11y-rooms` keyboard script (plan #57 §5.3, IA-015, T01-007, T08-008, INT-032): loops L1–L20,
 * keyboard only. Input goes through `press` and `type` of `keyboardCoverage.ts` (ESLint bans other
 * input here); the coverage check at the end fails on any control never operated and any state
 * never visited.
 */
import { expect, test, type Page } from '@playwright/test';
import { keyboardHarness, type KeyboardHarness } from './keyboardCoverage.ts';
import { enc, ORIGIN, T, timeTrigger } from './helpers.ts';

const QUICK = [
  ['5m', 'Last 5 minutes'],
  ['15m', 'Last 15 minutes'],
  ['30m', 'Last 30 minutes'],
  ['1h', 'Last 1 hour'],
  ['3h', 'Last 3 hours'],
  ['6h', 'Last 6 hours'],
  ['12h', 'Last 12 hours'],
  ['24h', 'Last 24 hours'],
  ['2d', 'Last 2 days'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
] as const;
const INTERVALS = ['off', '10s', '30s', '1m', '5m', '15m'] as const;
const INTERVAL_LABEL: Record<(typeof INTERVALS)[number], string> = {
  off: 'Off',
  '10s': '10s',
  '30s': '30s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
};
const REQUIRED_STATES = [
  '/t/:tenant/boards',
  '/t/:tenant/board/:uid',
  '/t/:tenant/explore/metrics',
  '/t/:tenant/explore/logs',
  '/t/:tenant/admin',
  '/signed-out',
  'not-found',
  'session-error',
];
const TRIGGER = 'button "<time range>"';
const NOV_18 = `from=${enc('2026-11-18T09:00:00.000Z')}&to=${enc('2026-11-18T10:00:00.000Z')}`;
const AT_10_11 = `from=${enc('2026-11-19T10:00:00.000Z')}&to=${enc('2026-11-19T11:00:00.000Z')}&refresh=off`;

declare global {
  interface Window {
    __copied: string[];
  }
}

type Target = string | RegExp;

function matches(focus: string, target: Target): boolean {
  return typeof target === 'string' ? focus === target : target.test(focus);
}

/** The script's steps over one page and harness. Input only through the harness's press and type. */
function script(page: Page, h: KeyboardHarness) {
  const { press, type } = h;

  /** Navigates (not input): the state the next rows start from. */
  async function goto(url: string): Promise<void> {
    await page.goto(url);
    await ready();
  }

  async function ready(): Promise<void> {
    const path = new URL(page.url()).pathname;
    if (path.startsWith('/t/')) await page.locator('html[data-shell-ready="true"]').waitFor();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/^Loading/);
  }

  /** Tabs (forwards, or backwards with `back`) until the focused control matches. */
  async function focus(target: Target, o: { back?: boolean; max?: number } = {}): Promise<void> {
    const max = o.max ?? 45;
    for (let i = 0; i <= max; i++) {
      const f = await h.focusName();
      if (matches(f, target)) return;
      await press(o.back === true ? 'Shift+Tab' : 'Tab');
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
  };
}

type Script = ReturnType<typeof script>;

test.describe('e2e:a11y-rooms keyboard', () => {
  test('every control and state by keyboard (L1–L20)', async ({ page }) => {
    test.setTimeout(900_000);
    await page.addInitScript(() => {
      window.__copied = [];
      const writeText = (s: string): Promise<void> => {
        if (localStorage.getItem('e2e.clipboard') === 'deny')
          return Promise.reject(new Error('denied'));
        window.__copied.push(s);
        return Promise.resolve();
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    });
    await page.clock.setFixedTime(T);
    const h = keyboardHarness(page);
    const s = script(page, h);
    const { press } = h;
    const nav = page.getByRole('navigation', { name: 'Main' });
    const navWidth = async (): Promise<number> => (await nav.boundingBox())?.width ?? 0;

    await test.step('L1 Tab order', async () => {
      await s.goto('/t/demo/boards');
      await page.evaluate(() => {
        localStorage.clear();
      });
      await s.goto('/t/demo/boards');
      const want = [
        'link "Skip to main content"',
        'link "Pulsus Dash home"',
        'button "Switch tenant, current: Demo"',
        'link "Boards"',
        'link "Metrics"',
        'link "Logs"',
        'link "Service overview"',
        'link "Admin"',
        'button "Collapse sidebar"',
        TRIGGER,
        'button "Refresh now"',
        'button "Auto-refresh interval: Off"',
        'button "User menu: Ada Admin"',
        'link "Service overview" #2',
      ];
      for (const [i, name] of want.entries()) {
        await press('Tab');
        expect(await h.focusName(), `Tab ${String(i + 1)}`).toBe(name);
        if (name === TRIGGER) await expect(timeTrigger(page)).toHaveText(/^Last 1 hour/);
      }
    });

    await test.step('L2 Links', async () => {
      await s.goto('/t/demo/boards?from=now-6h&to=now&refresh=30s');
      const ctx = { from: 'now-6h', to: 'now', refresh: '30s' };
      await s.on('link "Skip to main content"');
      await expect(page.locator('main')).toBeFocused();
      await s.goto('/t/demo/explore/metrics?from=now-6h&to=now&refresh=30s');
      await s.on('link "Pulsus Dash home"');
      await expect.poll(() => s.path()).toBe('/t/demo/boards');
      for (const [name, path] of [
        ['Metrics', '/t/demo/explore/metrics'],
        ['Logs', '/t/demo/explore/logs'],
        ['Admin', '/t/demo/admin'],
        ['Boards', '/t/demo/boards'],
      ] as const) {
        await s.on(`link "${name}"`);
        await expect.poll(() => s.path()).toBe(path);
        expect(s.search()).toEqual(ctx);
        await s.ready();
      }
      // The board list, in order: each board then appears first in Recent.
      for (const [i, uid] of ['b-1', 'b-2', 'b-3'].entries()) {
        await s.goto('/t/demo/boards?from=now-6h&to=now&refresh=30s');
        const link = page.getByRole('main').getByRole('link').nth(i);
        const title = await link.textContent();
        const links = page.getByRole('link', { name: title ?? '', exact: true });
        const n = await links.count();
        await s.on(n === 1 ? `link "${title ?? ''}"` : `link "${title ?? ''}" #${String(n)}`);
        await expect.poll(() => s.path()).toBe(`/t/demo/board/${uid}`);
        expect(s.search()).toEqual(ctx);
        await s.ready();
        const recent = nav
          .getByRole('heading', { name: 'Recent' })
          .locator('xpath=following-sibling::ul[1]');
        await expect(recent.getByRole('link').first()).toHaveText(title ?? '');
      }
      // Every link of the Starred and Recent groups (and any page link not yet followed).
      await s.everyLink('/t/demo/boards?from=now-6h&to=now&refresh=30s');
      await s.goto('/t/demo/board/b-1?from=now-6h&to=now&refresh=30s');
      const crumb = page
        .getByRole('navigation', { name: 'Breadcrumb' })
        .getByRole('link', { name: 'Boards' });
      await crumb.waitFor();
      await s.focus('link "Boards" #2');
      await expect(crumb).toBeFocused();
      await press('Enter');
      await expect.poll(() => s.path()).toBe('/t/demo/boards');
      expect(s.search()).toEqual(ctx);
    });

    await test.step('L3 Sidebar toggle', async () => {
      await s.goto('/t/demo/boards');
      await s.on('button "Collapse sidebar"');
      await expect.poll(navWidth).toBe(56);
      const toggle = page.getByRole('button', { name: 'Expand sidebar' });
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await press('Enter');
      await expect.poll(navWidth).toBe(240);
      const again = page.getByRole('button', { name: 'Collapse sidebar' });
      await expect(again).toBeFocused();
      await expect(again).toHaveAttribute('aria-expanded', 'true');
    });

    await test.step('L4 Quick ranges', async () => {
      await s.goto('/t/demo/boards');
      for (const [i, [x, label]] of QUICK.entries()) {
        await s.quickRange(i);
        await expect.poll(() => s.search()).toMatchObject({ from: `now-${x}`, to: 'now' });
        await expect(timeTrigger(page)).toBeFocused();
        await expect(timeTrigger(page)).toHaveText(new RegExp(`^${label}`));
      }
    });

    await test.step('L5 Range fields', async () => {
      await s.goto('/t/demo/boards');
      const from = s.dialog().getByRole('textbox', { name: 'From' });
      const to = s.dialog().getByRole('textbox', { name: 'To' });
      for (const [f, t, check] of [
        ['now-2h', 'now', 'ok'],
        ['now-1x', 'now', 'from'],
        ['now', 'now-1h', 'to'],
      ] as const) {
        const before = page.url();
        await s.openPicker();
        await s.replaceText('textbox "From"', f);
        await s.replaceText('textbox "To"', t);
        await s.on('button "Apply"');
        if (check === 'ok') {
          await expect.poll(() => s.search()).toMatchObject({ from: 'now-2h', to: 'now' });
          await expect(s.dialog()).toBeHidden();
          await expect(timeTrigger(page)).toBeFocused();
          continue;
        }
        if (check === 'from') {
          await expect(from).toHaveAttribute('aria-invalid', 'true');
          await expect(from).toBeFocused();
        } else {
          await expect(to).toHaveAttribute('aria-invalid', 'true');
          await expect(to).toHaveAccessibleDescription('To must be later than From');
          await expect(to).toBeFocused();
        }
        expect(page.url()).toBe(before);
        await press('Escape');
        await expect(s.dialog()).toBeHidden();
        await expect(timeTrigger(page)).toBeFocused();
      }
    });

    await test.step('L6 Calendar keys', async () => {
      await s.goto(`/t/demo/boards?${NOV_18}`);
      const heading = s.dialog().getByText(/^[A-Z][a-z]+ \d{4}$/);
      const cell = page.locator(':focus');
      for (const [key, day, month] of [
        ['ArrowRight', '19', 'November 2026'],
        ['ArrowLeft', '18', 'November 2026'],
        ['ArrowDown', '25', 'November 2026'],
        ['ArrowUp', '18', 'November 2026'],
        ['PageDown', '18', 'December 2026'],
        ['PageUp', '18', 'November 2026'],
        ['Shift+PageDown', '18', 'November 2027'],
        ['Shift+PageUp', '18', 'November 2026'],
        ['End', '30', 'November 2026'],
        ['Home', '1', 'November 2026'],
      ] as const) {
        if ((await s.dialog().count()) === 0) await s.openPicker();
        if ((await h.focusName()) !== 'grid "Calendar"') await s.focus('grid "Calendar"');
        await press(key);
        await expect(cell).toHaveText(day);
        await expect(heading).toHaveText(month);
      }
      await press('Escape');
    });

    await test.step('L7 Calendar buttons', async () => {
      await s.goto(`/t/demo/boards?${NOV_18}`);
      await s.openPicker();
      const heading = s.dialog().getByText(/^[A-Z][a-z]+ \d{4}$/);
      await s.focus('grid "Calendar"');
      await s.on('button "Next"', 'Enter', { back: true });
      await expect(heading).toHaveText('December 2026');
      await s.on('button "Previous"', 'Enter', { back: true });
      await press('Enter');
      await expect(heading).toHaveText('October 2026');
      await s.on('button "Next"');
      await expect(heading).toHaveText('November 2026');
      await press('Escape');
    });

    await test.step('L8 Calendar select', async () => {
      await s.goto(`/t/demo/boards?${NOV_18}`);
      await s.openPicker();
      await s.focus('grid "Calendar"');
      await expect(page.locator(':focus')).toHaveText('18');
      await press('Enter');
      // React Aria moves focus to the next day after the first date of a range is chosen.
      await expect(page.locator(':focus')).toHaveText('19');
      await press('Enter');
      await s.on('button "Apply"');
      await expect
        .poll(() => new URL(page.url()).search)
        .toBe(
          `?from=${enc('2026-11-18T00:00:00.000Z')}&to=${enc('2026-11-20T00:00:00.000Z')}&refresh=off`,
        );
      await expect(timeTrigger(page)).toHaveText(/^18 Nov 2026, 00:00:00 – 20 Nov 2026, 00:00:00/);
      expect(await page.evaluate(() => history.length)).toBeGreaterThan(1);
    });

    await test.step('L9 Share', async () => {
      await s.goto('/t/demo/boards?from=now-2h&to=now&refresh=off');
      await s.openPicker();
      await s.on('button "Copy link"');
      await expect(s.dialog().getByRole('status')).toHaveText('Link copied');
      let copied = await page.evaluate(() => window.__copied.at(-1) ?? '');
      expect(copied).toContain(
        `from=${enc('2026-11-19T11:03:00.000Z')}&to=${enc('2026-11-19T13:03:00.000Z')}`,
      );
      await s.on('checkbox "Keep relative"', 'Space');
      await expect(s.dialog().getByRole('checkbox', { name: 'Keep relative' })).toBeChecked();
      await s.on('button "Copy link"');
      await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(2);
      copied = await page.evaluate(() => window.__copied.at(-1) ?? '');
      expect(copied).toContain('from=now-2h&to=now');
      await press('Escape');
    });

    await test.step('L10 Refresh now', async () => {
      await s.goto('/t/demo/explore/metrics?from=now-1h&to=now&refresh=off');
      await expect(page.getByText(/^Showing /)).toHaveText(/19 Nov 2026, 12:03:00 – 13:03:00/);
      await page.clock.setFixedTime(T + 60_000);
      await s.on('button "Refresh now"');
      await expect(page.getByText(/^Showing /)).toHaveText(/19 Nov 2026, 12:04:00 – 13:04:00/);
      await page.clock.setFixedTime(T);
    });

    await test.step('L11 Intervals', async () => {
      await s.goto('/t/demo/boards');
      const length = await page.evaluate(() => history.length);
      for (const i of [1, 2, 3, 4, 5, 0]) {
        const id = INTERVALS[i] ?? 'off';
        await s.menuItem(/^button "Auto-refresh interval: /, i);
        await expect.poll(() => s.search()['refresh']).toBe(id);
        const button = page.getByRole('button', {
          name: `Auto-refresh interval: ${INTERVAL_LABEL[id]}`,
        });
        await expect(button).toBeFocused();
        expect(await page.evaluate(() => history.length)).toBe(length);
      }
    });

    await test.step('L12 Themes', async () => {
      await s.goto('/t/demo/boards');
      const html = page.locator('html');
      const stored = () => page.evaluate(() => localStorage.getItem('pulsus-dash.theme'));
      const user = page.getByRole('button', { name: 'User menu: Ada Admin' });
      await s.menuItem('button "User menu: Ada Admin"', 0);
      await expect(html).toHaveAttribute('data-theme', 'dark');
      expect(await stored()).toBe('dark');
      await expect(user).toBeFocused();
      await s.menuItem('button "User menu: Ada Admin"', 1);
      await expect(html).toHaveAttribute('data-theme', 'light');
      expect(await stored()).toBe('light');
      await page.emulateMedia({ colorScheme: 'light' });
      await s.menuItem('button "User menu: Ada Admin"', 2);
      await expect(html).toHaveAttribute('data-theme', 'light');
      expect(await stored()).toBe('system');
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(user).toBeFocused();
      await s.menuItem('button "User menu: Ada Admin"', 0);
    });

    await test.step('L13 About', async () => {
      await s.goto('/t/demo/boards');
      const about = page.getByRole('dialog', { name: 'About Pulsus Dash' });
      const user = page.getByRole('button', { name: 'User menu: Ada Admin' });
      await s.menuItem('button "User menu: Ada Admin"', 3);
      await expect(about).toBeVisible();
      await expect(about).toContainText('Version 0.1.0');
      await s.on('button "Close"');
      await expect(about).toBeHidden();
      await expect(user).toBeFocused();
      await s.menuItem('button "User menu: Ada Admin"', 3);
      await expect(about).toBeVisible();
      await press('Escape');
      await expect(about).toBeHidden();
      await expect(user).toBeFocused();
    });

    await test.step('L14 Page links', async () => {
      await s.goto('/t/demo/board/zzz');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board not found');
      await s.on('link "Back to boards"');
      await expect.poll(() => s.path()).toBe('/t/demo/boards');
      await s.goto('/nope');
      await s.on('link "Back to boards"');
      await expect.poll(() => s.path()).toBe('/t/demo/boards');
      await s.ready();
      await s.menuItem('button "User menu: Ada Admin"', 4);
      await expect.poll(() => s.path()).toBe('/signed-out');
      await s.ready();
      // The menu item that had focus is gone; the page puts focus on its main content.
      await expect(page.locator('main')).toBeFocused();
      await s.on('link "Sign in again"');
      await expect
        .poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
        .toBe('/t/demo/boards?from=now-1h&to=now&refresh=off');
    });

    await test.step('L15 Window keys', async () => {
      for (const [key, from, to] of [
        [']', '11:00', '12:00'],
        ['[', '09:00', '10:00'],
        ['-', '09:30', '11:30'],
        ['=', '10:15', '10:45'],
      ] as const) {
        await s.goto(`/t/demo/boards?${AT_10_11}`);
        await s.on('link "Skip to main content"');
        await expect(page.locator('main')).toBeFocused();
        await press(key);
        await expect
          .poll(() => s.search())
          .toMatchObject({
            from: `2026-11-19T${from}:00.000Z`,
            to: `2026-11-19T${to}:00.000Z`,
          });
      }
    });

    await test.step('L16 Clipboard denied', async () => {
      await s.goto('/t/demo/boards');
      await page.evaluate(() => {
        localStorage.setItem('e2e.clipboard', 'deny');
      });
      await s.openPicker();
      await s.on('button "Copy link"');
      await expect(s.dialog().getByRole('status')).toHaveText('Could not copy the link');
      const share = s.dialog().getByRole('textbox', { name: 'Share link' });
      await expect(share).toBeFocused();
      const sel = () =>
        share.evaluate((e) => {
          const i = e as HTMLInputElement;
          return [i.selectionStart, i.selectionEnd, i.value.length];
        });
      const [start, end, len] = await sel();
      expect(start).toBe(0);
      expect(end).toBe(len);
      await press('End');
      await press('ControlOrMeta+A');
      const [s2, e2, l2] = await sel();
      expect([s2, e2]).toEqual([0, l2]);
      await expect(share).toHaveValue(
        `${ORIGIN}/t/demo/boards?from=${enc('2026-11-19T12:03:00.000Z')}&to=${enc('2026-11-19T13:03:00.000Z')}&refresh=off`,
      );
      await page.evaluate(() => {
        localStorage.removeItem('e2e.clipboard');
      });
      await press('Escape');
    });

    await test.step('L17 Session error', async () => {
      await page.evaluate(() => {
        localStorage.setItem('pulsus-dash.stub.failSession', '1');
      });
      await page.goto('/t/demo/boards');
      await expect(
        page.getByRole('heading', { name: 'Pulsus Dash could not load your session' }),
      ).toBeVisible();
      await expect(nav).toHaveCount(0);
      await press('Tab');
      await expect(page.getByRole('button', { name: 'Retry' })).toBeFocused();
      await press('Enter');
      await expect(nav).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('pulsus-dash.stub.failSession'))).toBe(
        '0',
      );
      await expect(page.locator('main')).toBeFocused();
    });

    await test.step('L18 Tenant switch', async () => {
      await s.goto('/t/demo/boards?from=now-6h&to=now&refresh=30s');
      await s.menuItem('button "Switch tenant, current: Demo"', 1);
      await expect.poll(() => s.path()).toBe('/t/sandbox/boards');
      expect(s.search()).toEqual({ from: 'now-6h', to: 'now', refresh: '30s' });
      const trigger = page.getByRole('button', { name: 'Switch tenant, current: Sandbox' });
      await expect(trigger).toBeFocused();
      await expect(nav.getByText('No starred boards')).toBeVisible();
      await expect(nav.getByText('No recent boards')).toBeVisible();
      await s.menuItem('button "Switch tenant, current: Sandbox"', 0);
      await expect.poll(() => s.path()).toBe('/t/demo/boards');
      await expect(
        page.getByRole('button', { name: 'Switch tenant, current: Demo' }),
      ).toBeFocused();
    });

    await test.step('L19 Star', async () => {
      await s.goto('/t/demo/board/b-2');
      const star = page.getByRole('button', { name: 'Star board' });
      await expect(star).toBeEnabled();
      await s.on('button "Star board"');
      await expect(star).toHaveAttribute('aria-pressed', 'true');
      await expect(nav.getByRole('link', { name: 'Checkout latency' }).first()).toBeVisible();
      await expect(
        nav.getByRole('heading', { name: 'Starred' }).locator('xpath=following-sibling::ul[1]'),
      ).toContainText('Checkout latency');
      // The new Starred link and the other board links work from here (each opens a board).
      const boardTitles = ['Service overview', 'Checkout latency', 'Edge gateway'];
      await s.everyLink('/t/demo/board/b-2', (k) =>
        boardTitles.some((t) => k.startsWith(`link "${t}`)),
      );
      await s.goto('/t/demo/board/b-2');
      await s.on('button "Star board"');
      await expect(star).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('L20 Every page: header and sidebar controls and their overlays', async () => {
      for (const url of [
        '/t/demo/boards',
        '/t/demo/board/b-1',
        '/t/demo/explore/metrics',
        '/t/demo/explore/logs',
        '/t/demo/admin',
      ]) {
        await chrome(s, url);
      }
    });

    await test.step('Coverage', () => {
      const uncovered = h.uncovered();
      const unvisited = h.unvisited(REQUIRED_STATES);
      if (uncovered.length > 0) console.log(`Uncovered:\n${uncovered.join('\n')}`);
      expect(uncovered).toEqual([]);
      expect(unvisited).toEqual([]);
    });
  });
});

/** Operates every sidebar and header control on `url`, including each overlay's controls. */
async function chrome(s: Script, url: string): Promise<void> {
  const { page, h } = s;
  const { press } = h;
  await s.goto(url);
  await s.on('link "Skip to main content"');
  await expect(page.locator('main')).toBeFocused();

  // Every link: sidebar, breadcrumb and page body, each from this page.
  await s.everyLink(url);
  await s.goto(url);

  const star = page.getByRole('button', { name: 'Star board' });
  if ((await star.count()) > 0) {
    await expect(star).toBeEnabled();
    await s.on('button "Star board"');
    await press('Enter');
  }

  // Sidebar toggle.
  await s.on('button "Collapse sidebar"');
  await s.on('button "Expand sidebar"', 'Enter', { back: true });

  // Tenant menu: Demo (current), then Sandbox and back.
  await s.menuItem('button "Switch tenant, current: Demo"', 0);
  await s.menuItem('button "Switch tenant, current: Demo"', 1);
  await expect.poll(() => s.path()).toBe('/t/sandbox/boards');
  await s.goto(url);

  // Time range dialog: every quick range, the fields, calendar, Apply and share.
  for (let i = 0; i < 11; i++) await s.quickRange(i);
  await s.openPicker();
  await s.replaceText('textbox "From"', 'now-3h');
  await s.replaceText('textbox "To"', 'now');
  await s.on('button "Previous"');
  await s.on('button "Next"');
  await s.focus('grid "Calendar"');
  await press('ArrowRight');
  await s.on('checkbox "Keep relative"', 'Space');
  await s.on('button "Copy link"');
  await s.on('button "Apply"');
  await expect(s.dialog()).toBeHidden();
  await s.on('button "Refresh now"');

  // Auto-refresh interval: every value, ending at Off.
  for (const i of [1, 2, 3, 4, 5, 0]) await s.menuItem(/^button "Auto-refresh interval: /, i);

  // User menu: themes, About (Close), Sign out and back.
  for (const i of [1, 2, 0]) await s.menuItem('button "User menu: Ada Admin"', i);
  await s.menuItem('button "User menu: Ada Admin"', 3);
  await s.on('button "Close"');
  await s.menuItem('button "User menu: Ada Admin"', 4);
  await expect.poll(() => s.path()).toBe('/signed-out');
}
