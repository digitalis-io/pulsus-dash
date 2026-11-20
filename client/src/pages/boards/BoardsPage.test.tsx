import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { seedWith } from '../../test/seeds';
import { renderApp } from '../../test/renderApp';

describe('boards list', () => {
  it('lists the three seeded boards with Context-carrying links', async () => {
    renderApp('/t/demo/boards');
    const list = await screen.findByRole('list', { name: 'All boards' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Service overview',
      'Checkout latency',
      'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy',
    ]);
    expect(links[0]).toHaveAttribute('href', '/t/demo/board/b-1?from=now-1h&to=now&refresh=off');
    expect(within(list).getByText('Updated 18 Nov 2026, 09:30:00')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    renderApp('/t/demo/boards', {
      api: new StubApi(seedWith({ boards: { demo: [], sandbox: [] } })),
    });
    expect(await screen.findByText('No boards yet')).toBeInTheDocument();
  });
});
