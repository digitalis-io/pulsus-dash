import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { seedWith } from '../test/seeds';
import { locationOf, renderApp } from '../test/renderApp';
import { SIDEBAR_KEY } from './sidebarState';
import { orgInitial, tenantSwitchLabel } from './TenantSwitcher';

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

  it('tenantSwitchLabel starts with the visible initial when collapsed', () => {
    const cases: readonly (readonly [string, string, boolean, string])[] = [
      ['Demo', 'Demo Org', true, 'D, switch tenant, current: Demo'],
      ['Sandbox', 'acme', true, 'A, switch tenant, current: Sandbox'],
      ['Demo', 'Demo Org', false, 'Switch tenant, current: Demo'],
      ['Demo', '   ', true, 'Switch tenant, current: Demo'],
    ];
    for (const [name, org, collapsed, want] of cases) {
      expect(tenantSwitchLabel(name, org, collapsed)).toBe(want);
    }
    expect(orgInitial(' acme ')).toBe('A');
    expect(orgInitial('')).toBe('');
  });

  it("collapsed, the org-initial badge's name contains its visible letter", async () => {
    localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    const { router, user } = renderApp('/t/sandbox/boards?from=now-6h&to=now&refresh=30s');
    const badge = await screen.findByRole('button', {
      name: 'D, switch tenant, current: Sandbox',
    });
    expect(badge.textContent).toBe('D');
    await user.click(badge);
    await screen.findByRole('menu', { name: 'D, switch tenant, current: Sandbox' });
    await user.click(screen.getByRole('menuitemradio', { name: 'Demo' }));
    await waitFor(() => {
      expect(locationOf(router)).toBe('/t/demo/boards?from=now-6h&to=now&refresh=30s');
    });
  });
});
