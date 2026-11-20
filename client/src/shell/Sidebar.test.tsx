import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
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

describe('starred and recent groups', () => {
  it('lists starred boards from the API', async () => {
    renderApp('/t/demo/boards');
    const { starred } = await groups();
    await screen.findAllByRole('link', { name: 'Service overview' });
    expect(linksAfter(starred)).toEqual(['Service overview']);
    expect(await screen.findByText('No recent boards')).toBeInTheDocument();
  });

  it('shows empty texts and drops unknown recent uids', async () => {
    localStorage.setItem('pulsus-dash.stub.starred.demo', '[]');
    localStorage.setItem('pulsus-dash.recent.demo', JSON.stringify(['b-2', 'zzz', 'b-1']));
    renderApp('/t/demo/boards');
    const { recent } = await groups();
    expect(await screen.findByText('No starred boards')).toBeInTheDocument();
    await screen.findAllByRole('link', { name: 'Checkout latency' });
    expect(linksAfter(recent)).toEqual(['Checkout latency', 'Service overview']);
  });

  it('shows Admin only to administrators', async () => {
    renderApp('/t/demo/boards', { api: new StubApi(seedWith({ role: 'viewer' })) });
    const { nav } = await groups();
    expect(within(nav).queryByRole('link', { name: 'Admin' })).toBeNull();
  });
});
