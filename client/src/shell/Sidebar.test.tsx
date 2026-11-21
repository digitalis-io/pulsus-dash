import { act, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import { ApiError } from '../api/types';
import { failingApi } from '../test/failingApi';
import { seedWith } from '../test/seeds';
import { renderApp } from '../test/renderApp';

async function groups() {
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  return {
    nav,
    starred: within(nav).getByRole('heading', { name: 'Starred' }),
    recent: within(nav).getByRole('heading', { name: 'Recent' }),
  };
}

/** Links between a group heading and the next heading. */
function linksAfter(heading: HTMLElement): string[] {
  const out: string[] = [];
  let el = heading.nextElementSibling;
  while (el !== null && el.tagName !== 'H2') {
    for (const a of el.querySelectorAll('a')) out.push(a.textContent.replace('★', ''));
    el = el.nextElementSibling;
  }
  return out;
}

const EDGE = 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy';

describe('starred and recent groups', () => {
  it('lists starred boards from the API', async () => {
    renderApp('/t/demo/boards');
    const { starred } = await groups();
    await screen.findAllByRole('link', { name: 'Service overview' });
    expect(linksAfter(starred)).toEqual(['Service overview']);
    expect(await screen.findByText('No recent boards')).toBeInTheDocument();
  });

  it('recent comes from the API', async () => {
    localStorage.setItem('pulsus-dash.stub.starred', '[]');
    localStorage.setItem(
      'pulsus-dash.stub.recent',
      JSON.stringify([
        { uid: 'b-2', at: 3 },
        { uid: 'zzz', at: 2 },
        { uid: 'b-1', at: 1 },
      ]),
    );
    renderApp('/t/demo/boards');
    const { recent } = await groups();
    expect(await screen.findByText('No starred boards')).toBeInTheDocument();
    await waitFor(() => {
      expect(linksAfter(recent)).toEqual(['Checkout latency', 'Service overview']);
    });
  });

  it('old local recent is ignored', async () => {
    localStorage.setItem('pulsus-dash.recent.demo', JSON.stringify(['b-3']));
    renderApp('/t/demo/boards');
    const { recent } = await groups();
    expect(await screen.findByText('No recent boards')).toBeInTheDocument();
    expect(linksAfter(recent)).toEqual([]);
  });

  it('lists refetch on focus', async () => {
    renderApp('/t/demo/boards');
    const { starred, recent } = await groups();
    await waitFor(() => {
      expect(linksAfter(starred)).toEqual(['Service overview']);
    });
    // As another tab would.
    localStorage.setItem('pulsus-dash.stub.starred', '["b-1","b-2"]');
    localStorage.setItem('pulsus-dash.stub.recent', JSON.stringify([{ uid: 'b-3', at: 3 }]));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(
      () => {
        expect(linksAfter(starred)).toEqual(['Checkout latency', 'Service overview']);
        expect(linksAfter(recent)).toEqual([EDGE]);
      },
      { timeout: 1_000 },
    );
    act(() => {
      focusManager.setFocused(undefined);
    });
  });

  it('failed lists', async () => {
    const api = failingApi({
      listStarred: [new ApiError('unknown', 'x')],
      listRecent: [new ApiError('unknown', 'x')],
    });
    renderApp('/t/demo/boards', { api });
    expect(await screen.findByText('Could not load starred boards')).toBeInTheDocument();
    expect(await screen.findByText('Could not load recent boards')).toBeInTheDocument();
  });

  it('sidebar does not list every board', async () => {
    const api = new StubApi();
    const list = vi.spyOn(api, 'listBoards');
    renderApp('/t/demo/admin', { api });
    const { starred } = await groups();
    await waitFor(() => {
      expect(linksAfter(starred)).toEqual(['Service overview']);
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('shows Admin only to administrators', async () => {
    renderApp('/t/demo/boards', { api: new StubApi(seedWith({ role: 'viewer' })) });
    const { nav } = await groups();
    expect(within(nav).queryByRole('link', { name: 'Admin' })).toBeNull();
  });
});
