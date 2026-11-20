import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { ApiError, type DataSourceState, type DataSourceStatus } from '../api/types';
import { renderApp } from '../test/renderApp';
import { seedWith } from '../test/seeds';
import { SIDEBAR_KEY } from './sidebarState';

/** A StubApi whose data-source check resolves (or rejects) when the test says so. */
class ControlledApi extends StubApi {
  resolve: (s: DataSourceStatus) => void = () => undefined;
  reject: (e: unknown) => void = () => undefined;

  override checkDataSource(): Promise<DataSourceStatus> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

async function sidebar(): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  return nav.closest('aside') as HTMLElement;
}

describe('data-source status line (IA-021, plan #62 §4.6)', () => {
  it('shows "Not checked" until the check resolves', async () => {
    const api = new ControlledApi(seedWith());
    renderApp('/t/demo/boards', { api });
    const aside = await sidebar();
    expect(within(aside).getByText('Data source: demo · Not checked')).toBeInTheDocument();
    api.resolve({ state: 'ok', checkedAtMs: 1 });
    expect(await within(aside).findByText('Data source: demo · Connected')).toBeInTheDocument();
  });

  const states: [DataSourceState, string][] = [
    ['ok', 'Connected'],
    ['unreachable', 'Unreachable'],
    ['unauthorised', 'Not authorised'],
    ['error', 'Error'],
    ['notChecked', 'Not checked'],
  ];
  for (const [state, text] of states) {
    it(`shows ${state} as "${text}"`, async () => {
      const api = new ControlledApi(seedWith());
      renderApp('/t/demo/boards', { api });
      const aside = await sidebar();
      await within(aside).findByText('Data source: demo · Not checked');
      api.resolve({ state, checkedAtMs: 1 });
      expect(await within(aside).findByText(`Data source: demo · ${text}`)).toBeInTheDocument();
    });
  }

  it('stays "Not checked" when the check fails', async () => {
    const api = new ControlledApi(seedWith());
    renderApp('/t/demo/boards', { api });
    const aside = await sidebar();
    api.reject(new ApiError('network', 'down'));
    await new Promise((r) => setTimeout(r, 50));
    expect(within(aside).getByText('Data source: demo · Not checked')).toBeInTheDocument();
  });

  it('is not in the collapsed rail', async () => {
    localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    renderApp('/t/demo/boards', { api: new StubApi(seedWith()) });
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByText(/^Data source:/)).toBeNull();
  });
});
