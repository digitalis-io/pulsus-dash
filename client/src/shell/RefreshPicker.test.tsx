import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/renderApp';

describe('refresh menu', () => {
  it('selecting 30s replaces the URL and relabels the button', async () => {
    const { router, user } = renderApp('/t/demo/boards?from=now-1h&to=now&refresh=off');
    const button = await screen.findByRole('button', { name: 'Auto-refresh interval: Off' });
    const key = router.state.location.key;
    await user.click(button);
    await user.click(await screen.findByRole('menuitemradio', { name: '30s' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('refresh')).toBe('30s');
    });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.key).not.toBe(key);
    expect(
      await screen.findByRole('button', { name: 'Auto-refresh interval: 30s' }),
    ).toHaveTextContent('30s');
  });
});
