import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { createClock } from '../state/clock';
import { locationOf, renderApp, T } from '../test/renderApp';

// Explore › Metrics measures its chart host (plan #63 Part C).
beforeEach(() => {
  installResizeObserver();
});

const enc = (iso: string): string => encodeURIComponent(iso);

async function openPicker(user: ReturnType<typeof renderApp>['user']) {
  const trigger = await screen.findByRole('button', { name: /^(Last|\d|now)/ });
  await user.click(trigger);
  return screen.findByRole('dialog', { name: 'Time range' });
}

function stubClipboard(writeText: (s: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('picker quick range', () => {
  it('Last 6 hours sets now-6h…now and relabels the trigger', async () => {
    const { router, user } = renderApp('/t/demo/boards');
    const dialog = await openPicker(user);
    await user.click(await within(dialog).findByRole('option', { name: 'Last 6 hours' }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('from=now-6h&to=now');
    });
    expect(await screen.findByRole('button', { name: /^Last 6 hours/ })).toBeInTheDocument();
  });
});

describe('picker validation', () => {
  it('marks From invalid with the unit named, keeps the URL and focuses From', async () => {
    const { router, user } = renderApp('/t/demo/boards');
    await screen.findByRole('heading', { level: 1, name: 'Boards' });
    const before = locationOf(router);
    const dialog = await openPicker(user);
    const from = await within(dialog).findByRole('textbox', { name: 'From' });
    await user.clear(from);
    await user.type(from, 'now-1x');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(from).toHaveAccessibleDescription(/“x”/);
    expect(from).toHaveFocus();
    expect(locationOf(router)).toBe(before);

    await user.clear(from);
    await user.type(from, 'now');
    const to = within(dialog).getByRole('textbox', { name: 'To' });
    await user.clear(to);
    await user.type(to, 'now-1h');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(to).toHaveAccessibleDescription('To must be later than From');
    expect(to).toHaveFocus();
  });
});

describe('picker copy link', () => {
  it('pins to the anchor, keeps relative on request, and falls back when the clipboard fails', async () => {
    let now = T;
    const clock = createClock(() => now);
    const writeText = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
    const { user } = renderApp('/t/demo/explore/metrics?from=now-1h&to=now&refresh=off', { clock });
    stubClipboard(writeText); // after userEvent.setup(), which installs its own clipboard
    await screen.findByText(/^Showing 19 Nov 2026, 12:03:00 – 13:03:00/);
    now = T + 600_000; // the wall clock moves on; the anchor does not
    const dialog = await openPicker(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Copy link' }));
    await within(dialog).findByText('Link copied');
    expect(writeText.mock.calls[0]?.[0]).toContain(
      `from=${enc('2026-11-19T12:03:00.000Z')}&to=${enc('2026-11-19T13:03:00.000Z')}`,
    );
    await user.click(within(dialog).getByRole('checkbox', { name: 'Keep relative' }));
    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2);
    });
    expect(writeText.mock.calls[1]?.[0]).toContain('from=now-1h&to=now');

    await user.click(within(dialog).getByRole('checkbox', { name: 'Keep relative' }));
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(await within(dialog).findByText('Could not copy the link')).toBeInTheDocument();
    const share = within(dialog).getByRole('textbox', { name: 'Share link' });
    await waitFor(() => {
      expect(share).toHaveFocus();
    });
    const input = share as HTMLInputElement;
    expect(input.value).toBe(
      `${location.origin}/t/demo/explore/metrics?from=${enc('2026-11-19T12:03:00.000Z')}&to=${enc('2026-11-19T13:03:00.000Z')}&refresh=off`,
    );
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});

async function pickDays(
  user: ReturnType<typeof renderApp>['user'],
  dialog: HTMLElement,
  first: string,
  last: string,
): Promise<void> {
  const grid = within(dialog).getByRole('grid');
  const cell = (d: string): HTMLElement => {
    const el = within(grid)
      .getAllByText(d)
      .find((e) => !e.closest('[data-outside-month]') && e.getAttribute('aria-hidden') !== 'true');
    if (el === undefined) throw new Error(`no day ${d}`);
    return el;
  };
  await user.click(cell(first));
  await user.click(cell(last));
}

describe('calendar range', () => {
  it('selects whole days in the browser zone and applies them', async () => {
    const url = `/t/demo/boards?from=${enc('2026-11-18T09:00:00.000Z')}&to=${enc('2026-11-18T10:00:00.000Z')}`;
    const { router, user } = renderApp(url);
    const dialog = await openPicker(user);
    expect(within(dialog).getByText(/Time zone: Europe\/London/)).toBeInTheDocument();
    expect(within(dialog).getByText('November 2026')).toBeInTheDocument();
    await pickDays(user, dialog, '18', '19');
    expect(within(dialog).getByRole('textbox', { name: 'From' })).toHaveValue(
      '2026-11-18T00:00:00.000Z',
    );
    expect(within(dialog).getByRole('textbox', { name: 'To' })).toHaveValue(
      '2026-11-20T00:00:00.000Z',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe(
        `?from=${enc('2026-11-18T00:00:00.000Z')}&to=${enc('2026-11-20T00:00:00.000Z')}&refresh=off`,
      );
    });
    expect(router.state.historyAction).toBe('PUSH');
  });

  it('uses New York midnights in New York', async () => {
    const url = `/t/demo/boards?from=${enc('2026-11-18T09:00:00.000Z')}&to=${enc('2026-11-18T10:00:00.000Z')}`;
    const { user } = renderApp(url, { timeZone: 'America/New_York' });
    const dialog = await openPicker(user);
    await pickDays(user, dialog, '18', '19');
    expect(within(dialog).getByRole('textbox', { name: 'From' })).toHaveValue(
      '2026-11-18T05:00:00.000Z',
    );
    expect(within(dialog).getByRole('textbox', { name: 'To' })).toHaveValue(
      '2026-11-20T05:00:00.000Z',
    );
  });
});

describe('calendar across DST', () => {
  it('March: 47 hours; October: 25 hours', async () => {
    const march = `/t/demo/boards?from=${enc('2026-03-20T00:00:00.000Z')}&to=${enc('2026-03-21T00:00:00.000Z')}`;
    const first = renderApp(march);
    let dialog = await openPicker(first.user);
    expect(within(dialog).getByText('March 2026')).toBeInTheDocument();
    await pickDays(first.user, dialog, '28', '29');
    await first.user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(first.router.state.location.search).toBe(
        `?from=${enc('2026-03-28T00:00:00.000Z')}&to=${enc('2026-03-29T23:00:00.000Z')}&refresh=off`,
      );
    });
    first.view.unmount();

    const october = `/t/demo/boards?from=${enc('2026-10-20T00:00:00.000Z')}&to=${enc('2026-10-21T00:00:00.000Z')}`;
    const second = renderApp(october);
    dialog = await openPicker(second.user);
    await pickDays(second.user, dialog, '25', '25');
    await second.user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(second.router.state.location.search).toBe(
        `?from=${enc('2026-10-24T23:00:00.000Z')}&to=${enc('2026-10-26T00:00:00.000Z')}&refresh=off`,
      );
    });
  });
});
