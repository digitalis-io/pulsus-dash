import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { ApiError, type DataSourceState, type DataSourceStatus } from '../api/types';
import { renderApp } from '../test/renderApp';
import { seedWith } from '../test/seeds';
import { SIDEBAR_KEY } from './sidebarState';

/**
 * A StubApi whose data-source check resolves (or rejects) when the test says so. `resolve` and
 * `reject` first wait until the shell has called `checkDataSource`: the line shows "Not checked"
 * before the query starts, so settling earlier would be lost on a slow runner.
 */
class ControlledApi extends StubApi {
  private settle: ((s: DataSourceStatus) => void) | undefined;
  private fail: ((e: unknown) => void) | undefined;
  private markCalled: () => void = () => undefined;
  private readonly called = new Promise<void>((resolve) => {
    this.markCalled = resolve;
  });

  override checkDataSource(): Promise<DataSourceStatus> {
    return new Promise((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
      this.markCalled();
    });
  }

  async resolve(s: DataSourceStatus): Promise<void> {
    await this.called;
    this.settle?.(s);
  }

  async reject(e: unknown): Promise<void> {
    await this.called;
    this.fail?.(e);
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
    await api.resolve({ state: 'ok', checkedAtMs: 1 });
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
      await api.resolve({ state, checkedAtMs: 1 });
      expect(await within(aside).findByText(`Data source: demo · ${text}`)).toBeInTheDocument();
    });
  }

  it('stays "Not checked" when the check fails', async () => {
    const api = new ControlledApi(seedWith());
    renderApp('/t/demo/boards', { api });
    const aside = await sidebar();
    await api.reject(new ApiError('network', 'down'));
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
