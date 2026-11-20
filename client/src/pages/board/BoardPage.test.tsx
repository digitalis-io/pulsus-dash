import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';
import { readRecent } from '../../shell/recentBoards';

describe('star toggle', () => {
  it('stars and unstars the board and records it as recent', async () => {
    const { user } = renderApp('/t/demo/board/b-2');
    const star = await screen.findByRole('button', { name: 'Star board' });
    await waitFor(() => {
      expect(star).toBeEnabled();
    });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await user.click(star);
    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'true');
    });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link', { name: 'Checkout latency' }).length).toBeGreaterThan(
      0,
    );
    expect(localStorage.getItem('pulsus-dash.stub.starred.demo')).toBe('["b-1","b-2"]');
    await user.click(star);
    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'false');
    });
    expect(readRecent(localStorage, 'demo')).toEqual(['b-2']);
  });

  it('is not shown on the boards list', async () => {
    renderApp('/t/demo/boards');
    await screen.findByRole('heading', { level: 1, name: 'Boards' });
    expect(screen.queryByRole('button', { name: 'Star board' })).toBeNull();
  });
});

describe('board page', () => {
  it('shows the board title in the header and the document title', async () => {
    renderApp('/t/demo/board/b-1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Service overview' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe('Service overview · Pulsus Dash');
    });
  });

  it('shows Board not found for an unknown uid', async () => {
    renderApp('/t/demo/board/zzz');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Board not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to boards' })).toBeInTheDocument();
  });
});
