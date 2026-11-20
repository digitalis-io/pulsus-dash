import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/renderApp';

const URL_10_11 =
  '/t/demo/explore/metrics?from=2026-11-19T10%3A00%3A00.000Z&to=2026-11-19T11%3A00%3A00.000Z&refresh=off';

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  fireEvent(target, e);
  return e;
}

describe('window keys', () => {
  it('] on the page steps forward and is prevented; ignored in a field and with modifiers', async () => {
    const { router, user } = renderApp(URL_10_11);
    await screen.findByRole('heading', { level: 1, name: 'Metrics' });
    const e = key(document.body, { key: ']', code: 'BracketRight' });
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('from')).toBe(
        '2026-11-19T11:00:00.000Z',
      );
    });

    const before = router.state.location.search;
    await user.click(await screen.findByRole('button', { name: /11:00:00 – 12:00:00/ }));
    const from = await screen.findByRole('textbox', { name: 'From' });
    const inField = key(from, { key: ']', code: 'BracketRight' });
    expect(inField.defaultPrevented).toBe(false);
    await user.keyboard('{Escape}');
    const ctrl = key(document.body, { key: ']', code: 'BracketRight', ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(router.state.location.search).toBe(before);
  });
});

describe('IA-002 time subset', () => {
  it('the header and the page show the same window after ]', async () => {
    const { router } = renderApp(URL_10_11);
    await screen.findByRole('heading', { level: 1, name: 'Metrics' });
    key(document.body, { key: ']', code: 'BracketRight' });
    await waitFor(() => {
      expect(router.state.location.search).toContain('from=2026-11-19T11');
    });
    const range = '19 Nov 2026, 11:00:00 – 12:00:00';
    expect(await screen.findByRole('button', { name: new RegExp(range) })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^Showing ${range}`))).toBeInTheDocument();
  });
});
