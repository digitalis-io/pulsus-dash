import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { seedWith } from '../test/seeds';
import { locationOf, renderApp } from '../test/renderApp';

describe('tenant switcher', () => {
  it('with two bindings, is a menu that switches tenant keeping the Context', async () => {
    const { router, user } = renderApp('/t/demo/boards?from=now-6h&to=now&refresh=30s');
    const trigger = await screen.findByRole('button', { name: 'Switch tenant, current: Demo' });
    await user.click(trigger);
    const demo = await screen.findByRole('menuitemradio', { name: 'Demo' });
    expect(demo).toHaveAttribute('aria-checked', 'true');
    const sandbox = screen.getByRole('menuitemradio', { name: 'Sandbox' });
    expect(sandbox).toHaveAttribute('aria-checked', 'false');
    await user.click(sandbox);
    await waitFor(() => {
      expect(locationOf(router)).toBe('/t/sandbox/boards?from=now-6h&to=now&refresh=30s');
    });
    expect(router.state.historyAction).toBe('PUSH');
  });

  it('with one binding, is static text', async () => {
    renderApp('/t/demo/boards', { api: new StubApi(seedWith({ tenants: ['demo'] })) });
    const org = await screen.findByText('Demo Org');
    const block = org.parentElement;
    expect(block).not.toBeNull();
    expect(screen.getByText('Tenant: Demo')).toBeInTheDocument();
    expect(block?.closest('button')).toBeNull();
    expect(block?.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Switch tenant/ })).toBeNull();
  });
});
