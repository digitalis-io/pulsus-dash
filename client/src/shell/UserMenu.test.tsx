import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import { ApiError } from '../api/types';
import { locationOf, renderApp } from '../test/renderApp';

function mockMatchMedia(light: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('light') ? light : !light,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('user menu', () => {
  it('shows the identity, switches theme and signs out', async () => {
    mockMatchMedia(true);
    const api = new StubApi();
    const signOut = vi.spyOn(api, 'signOut');
    const { router, user } = renderApp('/t/demo/boards', { api });
    await user.click(await screen.findByRole('button', { name: 'User menu: Ada Admin' }));
    expect(await screen.findByText('Ada Admin')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Admin', { selector: 'p' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
    expect(localStorage.getItem('pulsus-dash.theme')).toBe('light');

    await user.click(screen.getByRole('button', { name: 'User menu: Ada Admin' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });
    await user.click(screen.getByRole('button', { name: 'User menu: Ada Admin' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'System' }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
    expect(localStorage.getItem('pulsus-dash.theme')).toBe('system');

    await user.click(screen.getByRole('button', { name: 'User menu: Ada Admin' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => {
      expect(locationOf(router)).toBe('/signed-out');
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { name: 'You have signed out' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('main')).toHaveFocus();
    });
  });
});

describe('sign out rejected', () => {
  it('keeps the session and the shell, shows a recoverable alert, and Retry signs out', async () => {
    const api = new StubApi();
    const signOut = vi
      .spyOn(api, 'signOut')
      .mockImplementationOnce(() => Promise.reject(new ApiError('network', 'down')))
      .mockImplementation(() => Promise.resolve());
    const { router, user, queryClient } = renderApp('/t/demo/boards', { api });
    await user.click(await screen.findByRole('button', { name: 'User menu: Ada Admin' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not sign out. You are still signed in.');
    expect(locationOf(router)).toBe('/t/demo/boards?from=now-1h&to=now&refresh=off');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(queryClient.getQueryData(['session'])).toBeDefined();
    expect(queryClient.getQueryData(['boards', 'demo'])).toBeDefined();
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    await waitFor(() => {
      expect(retry).toHaveFocus();
    });

    await user.click(retry);
    await waitFor(() => {
      expect(locationOf(router)).toBe('/signed-out');
    });
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(['session'])).toBeUndefined();
  });

  it('Dismiss closes the alert and returns focus to the user menu', async () => {
    const api = new StubApi();
    vi.spyOn(api, 'signOut').mockImplementation(() =>
      Promise.reject(new ApiError('network', 'down')),
    );
    const { user } = renderApp('/t/demo/boards', { api });
    const trigger = await screen.findByRole('button', { name: 'User menu: Ada Admin' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
