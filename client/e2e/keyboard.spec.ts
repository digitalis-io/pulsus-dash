/**
 * `e2e:a11y-rooms` keyboard script (plan #57 §5.3, IA-015, T01-007, T08-008, INT-032; plan #58 L22;
 * plan #61 Part B L23–L28, Appendix B-A §A.5; Part C L29–L31, Appendix C-A §A.3): loops L1–L31,
 * keyboard only. Input goes through `press` and `type` of `keyboardCoverage.ts`
 * (ESLint bans other input here); the coverage check at the end fails on any control never operated
 * and any state never visited.
 */
import { expect, test } from '@playwright/test';
import { boardLoops } from './keyboardBoards.ts';
import { keyboardHarness } from './keyboardCoverage.ts';
import { script, TRIGGER, type Script } from './keyboardScript.ts';
import { enc, GALLERY_FROM, GALLERY_TO, GALLERY_URL, ORIGIN, T, timeTrigger } from './helpers.ts';

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
  '/t/:tenant/dev/gallery',
  '/signed-out',
  'not-found',
  'session-error',
];
const NOV_18 = `from=${enc('2026-11-18T09:00:00.000Z')}&to=${enc('2026-11-18T10:00:00.000Z')}`;
const AT_10_11 = `from=${enc('2026-11-19T10:00:00.000Z')}&to=${enc('2026-11-19T11:00:00.000Z')}&refresh=off`;

declare global {
  interface Window {
    __copied: string[];
  }
}

test.describe('e2e:a11y-rooms keyboard', () => {
  test('every control and state by keyboard (L1–L31)', async ({ page }) => {
    test.setTimeout(3_600_000);
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
        'button "New board"',
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
      // Starred and Recent belong to the organisation and user, not the tenant (plan #61 Part C).
      await expect(
        nav
          .getByRole('heading', { name: 'Starred' })
          .locator('xpath=following-sibling::*[1]')
          .getByRole('link')
          .first(),
      ).toHaveText(/Service overview/);
      await expect(nav.getByText('No recent boards')).toHaveCount(0);
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

    await test.step('L21 Sign out rejected', async () => {
      await s.goto('/t/demo/boards');
      // The stub's test hook rejects the next two sign-out calls; the third succeeds.
      await page.evaluate(() => {
        localStorage.setItem('pulsus-dash.stub.failSignOut', '2');
      });
      const alert = page.getByRole('alert');
      const retry = alert.getByRole('button', { name: 'Retry' });
      const user = page.getByRole('button', { name: 'User menu: Ada Admin' });
      await s.menuItem('button "User menu: Ada Admin"', 4);
      await expect(alert).toHaveText(/Could not sign out\. You are still signed in\./);
      await expect(retry).toBeFocused();
      // The session is kept: still in the shell, on the same page.
      expect(s.path()).toBe('/t/demo/boards');
      await expect(nav).toBeVisible();
      await expect(user).toBeVisible();
      await s.on('button "Dismiss"', 'Enter', { back: true });
      await expect(alert).toBeHidden();
      await expect(user).toBeFocused();
      await s.menuItem('button "User menu: Ada Admin"', 4);
      await expect(retry).toBeFocused();
      expect(s.path()).toBe('/t/demo/boards');
      await expect(nav).toBeVisible();
      await s.on('button "Retry"');
      await expect.poll(() => s.path()).toBe('/signed-out');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('You have signed out');
      expect(await page.evaluate(() => localStorage.getItem('pulsus-dash.stub.failSignOut'))).toBe(
        '0',
      );
      const covered = [...h.operated()];
      expect(covered).toContain('/t/:tenant/boards + none › button "Retry"');
      expect(covered).toContain('/t/:tenant/boards + none › button "Dismiss"');
    });

    await test.step('L20 Every page: header and sidebar controls and their overlays', async () => {
      for (const url of [
        '/t/demo/boards',
        '/t/demo/board/b-1',
        '/t/demo/explore/metrics',
        '/t/demo/explore/logs',
        '/t/demo/admin',
        '/t/demo/dev/gallery',
      ]) {
        await chrome(s, url);
      }
    });

    await test.step('L22 Chart frames: the crosshair slider of every chart', async () => {
      await s.goto(GALLERY_URL);
      await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(7);
      const MIN = 60_000;
      const lineStep = Math.floor((GALLERY_TO - GALLERY_FROM) / 1_440);
      // Title, last sample or bucket start, the second one, and the rows at a sample.
      const charts: [string, number, number, number][] = [
        ['Request rate, 1 series', GALLERY_FROM + 1_439 * lineStep, GALLERY_FROM + lineStep, 1],
        [
          'Request latency, 50 series × 1 440 points',
          GALLERY_FROM + 1_439 * lineStep,
          GALLERY_FROM + lineStep,
          50,
        ],
        [
          'Queue depth with gaps, 3 series',
          GALLERY_FROM + 1_439 * lineStep,
          GALLERY_FROM + lineStep,
          3,
        ],
        ['Pod memory, 600 series', GALLERY_FROM + 59 * MIN, GALLERY_FROM + MIN, 500],
        ['Request latency distribution', GALLERY_FROM + 59 * MIN, GALLERY_FROM + MIN, 12],
        ['Log volume by level', GALLERY_FROM + 59 * MIN, GALLERY_FROM + MIN, 5],
      ];
      for (const [title, last, second, n] of charts) {
        const name = `Crosshair: ${title}`;
        const slider = page.getByRole('slider', { name, exact: true });
        const tip = page
          .locator('[data-chart-frame]', { has: slider })
          .locator('[data-chart-tooltip]');
        await s.focus(`slider "${name}"`, { max: 60 });
        await press('End');
        await expect(slider).toHaveAttribute('aria-valuenow', String(last));
        await expect(tip).toBeVisible();
        await expect(tip.locator('[data-row]').first()).toBeVisible();
        await press('ArrowLeft');
        await press('Home');
        await press('ArrowRight');
        await expect(slider).toHaveAttribute('aria-valuenow', String(second));
        await press('ArrowDown');
        if (n > 1)
          await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(`2 of ${String(n)}$`));
        await press('Escape');
        await expect(tip).toBeHidden();
        await expect(slider).toHaveAttribute('aria-valuetext', 'Use the arrow keys to read values');
      }
    });

    // L23–L31 (plan #61 Parts B and C): the board list and the board page.
    await boardLoops(s);

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
  // Share controls exist only on pages with a view URL pattern (not on the dev gallery).
  if ((await s.dialog().getByRole('checkbox', { name: 'Keep relative' }).count()) > 0) {
    await s.on('checkbox "Keep relative"', 'Space');
    await s.on('button "Copy link"');
  }
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
