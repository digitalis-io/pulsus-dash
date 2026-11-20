import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { renderApp } from '../test/renderApp';
import { seedWith } from '../test/seeds';
import { DataSourceStatus } from './DataSourceStatus';
import { SIDEBAR_KEY } from './sidebarState';

describe('data-source status line (A4, IA-021)', () => {
  it('renders the tenant slug and "Not checked"', () => {
    render(
      <DataSourceStatus
        tenant={{ slug: 'demo', name: 'Demo', dataSource: { state: 'notChecked' } }}
      />,
    );
    expect(screen.getByText('Data source: demo · Not checked')).toBeInTheDocument();
  });

  it('renders nothing for a tenant without a data source', () => {
    const { container } = render(<DataSourceStatus tenant={{ slug: 'demo', name: 'Demo' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is in the expanded sidebar footer and not in the collapsed rail', async () => {
    const { view } = renderApp('/t/demo/boards');
    const sidebar = (await screen.findByRole('navigation', { name: 'Main' })).closest('aside');
    expect(sidebar).not.toBeNull();
    expect(
      within(sidebar as HTMLElement).getByText('Data source: demo · Not checked'),
    ).toBeInTheDocument();
    view.unmount();

    localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    renderApp('/t/demo/boards', { api: new StubApi(seedWith()) });
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByText(/^Data source:/)).toBeNull();
  });
});
