import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { StubApi } from '../api/StubApi';
import { ApiError } from '../api/types';
import { createQueryClient } from '../app/queryClient';
import { renderApp } from '../test/renderApp';

// Explore › Metrics measures its chart host (plan #63 Part C).
beforeEach(() => {
  installResizeObserver();
});

function noSearchControl(): void {
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /search|⌘K|command/i })).toBeNull();
}

describe('header breadcrumb', () => {
  it('shows Boards before the title on a board page', async () => {
    renderApp('/t/demo/board/b-1');
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Service overview' });
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const link = within(crumb).getByRole('link', { name: 'Boards' });
    expect(link.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(h1).toHaveAttribute('title', 'Service overview');
    noSearchControl();
  });

  it('shows Explore as text before Metrics', async () => {
    renderApp('/t/demo/explore/metrics');
    await screen.findByRole('heading', { level: 1, name: 'Metrics' });
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumb).toHaveTextContent('Explore');
    expect(within(crumb).queryByRole('link')).toBeNull();
    noSearchControl();
  });

  it('has no breadcrumb on Boards', async () => {
    renderApp('/t/demo/boards');
    await screen.findByRole('heading', { level: 1, name: 'Boards' });
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    noSearchControl();
  });
});

describe('session error and retry', () => {
  it('shows the error after one call; Retry renders the shell and focuses main', async () => {
    const api = new StubApi();
    const real = api.getSession.bind(api);
    const getSession = vi
      .spyOn(api, 'getSession')
      .mockImplementationOnce(() => Promise.reject(new ApiError('network', 'down')))
      .mockImplementation(real);
    const { user } = renderApp('/t/demo/boards', { api, queryClient: createQueryClient() });
    expect(
      await screen.findByRole('heading', { name: 'Pulsus Dash could not load your session' }),
    ).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(1);
    await user.tab();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.getElementById('main')).toHaveFocus();
    });
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
