import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import { ApiError } from '../api/types';
import { locationOf, renderApp } from '../test/renderApp';
import { seedWith } from '../test/seeds';
import { t } from '../i18n/t';
import { initials, userMenuButtonLabel } from './UserMenu';

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
    await user.click(await screen.findByRole('button', { name: 'AA, user menu: Ada Admin' }));
    // The board list shows the name too (Updated by); the menu's identity is a paragraph.
    expect(await screen.findByText('Ada Admin', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Admin', { selector: 'p' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
    expect(localStorage.getItem('pulsus-dash.theme')).toBe('light');

    await user.click(screen.getByRole('button', { name: 'AA, user menu: Ada Admin' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });
    await user.click(screen.getByRole('button', { name: 'AA, user menu: Ada Admin' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'System' }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
    expect(localStorage.getItem('pulsus-dash.theme')).toBe('system');

    await user.click(screen.getByRole('button', { name: 'AA, user menu: Ada Admin' }));
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
    await user.click(await screen.findByRole('button', { name: 'AA, user menu: Ada Admin' }));
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
    const trigger = await screen.findByRole('button', { name: 'AA, user menu: Ada Admin' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('sign out under the fixed local principal (A2, D12)', () => {
  it('hides Sign out when the session cannot sign out, and shows it when it can', async () => {
    for (const canSignOut of [false, true]) {
      const seed = seedWith();
      seed.session.canSignOut = canSignOut;
      const { user, view } = renderApp('/t/demo/boards', { api: new StubApi(seed) });
      await user.click(await screen.findByRole('button', { name: 'AA, user menu: Ada Admin' }));
      await screen.findByRole('menuitem', { name: 'About Pulsus Dash' });
      expect(screen.queryByRole('menuitem', { name: 'Sign out' }) !== null).toBe(canSignOut);
      view.unmount();
    }
  });
});

describe('About shows the server version (A3)', () => {
  it('shows the server line only when the session has a server', async () => {
    for (const server of [{ version: '9.9.9', commit: 'abc' }, null]) {
      const seed = seedWith();
      seed.session.server = server;
      const { user, view } = renderApp('/t/demo/boards', { api: new StubApi(seed) });
      await user.click(await screen.findByRole('button', { name: 'AA, user menu: Ada Admin' }));
      await user.click(await screen.findByRole('menuitem', { name: 'About Pulsus Dash' }));
      const dialog = await screen.findByRole('dialog', { name: 'About Pulsus Dash' });
      if (server === null) {
        expect(within(dialog).queryByText(/^Server version/)).toBeNull();
      } else {
        expect(within(dialog).getByText('Server version 9.9.9')).toBeInTheDocument();
      }
      view.unmount();
    }
  });
});

describe('user menu button label (WCAG 2.5.3, label in name)', () => {
  it('userMenuButtonLabel puts the visible initials first', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['Ada Admin', 'AA, user menu: Ada Admin'],
      ['Local user', 'LU, user menu: Local user'],
      ['grace brewster hopper', 'GB, user menu: grace brewster hopper'],
      ['Zoë', 'Z, user menu: Zoë'],
      ['   ', t('user.menu', { name: '   ' })],
    ];
    for (const [name, label] of cases) {
      expect(userMenuButtonLabel(name), name).toBe(label);
      if (initials(name) !== '') {
        expect(userMenuButtonLabel(name).startsWith(`${initials(name)},`), name).toBe(true);
      }
    }
    expect(userMenuButtonLabel('   ')).toBe('User menu:    ');
  });

  it("the avatar button's name contains its visible text", async () => {
    const seed = seedWith();
    seed.session.user.name = 'Local user';
    const { user } = renderApp('/t/demo/boards', { api: new StubApi(seed) });
    const button = await screen.findByRole('button', { name: 'LU, user menu: Local user' });
    expect(button.textContent).toBe('LU');
    expect(button.getAttribute('aria-label')).toContain('LU');
    await user.click(button);
    expect(await screen.findByRole('menu', { name: 'User menu: Local user' })).toBeInTheDocument();
  });
});
