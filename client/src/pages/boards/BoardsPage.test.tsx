import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { ApiError, BoardConflictError, type BoardList } from '../../api/types';
import { formatDate, formatTime } from '../../i18n/format';
import { failingApi } from '../../test/failingApi';
import { seedWith } from '../../test/seeds';
import { locationOf, renderApp } from '../../test/renderApp';

const EDGE = 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy';

async function table() {
  return screen.findByRole('table', { name: 'All boards' });
}

function bodyRows(t: HTMLElement): HTMLElement[] {
  const groups = within(t).getAllByRole('rowgroup');
  const body = groups.at(-1);
  if (body === undefined) throw new Error('no table body');
  return within(body).getAllByRole('row');
}

async function rowTitles(): Promise<string[]> {
  return bodyRows(await table()).map((r) => within(r).getByRole('link').textContent);
}

async function dialog(name: string) {
  return screen.findByRole('dialog', { name });
}

/** A conflict as the stub would raise it for `uid`. */
async function conflictFor(uid: string): Promise<BoardConflictError> {
  return new BoardConflictError(await new StubApi().getBoard('demo', uid));
}

describe('board list', () => {
  it('lists boards in a table', async () => {
    renderApp('/t/demo/boards');
    const rows = bodyRows(await table());
    expect(rows).toHaveLength(3);
    const ms = Date.parse('2026-11-18T09:30:00.000Z');
    const cells = within(rows[0] ?? document.body).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual([
      'Service overview',
      `${formatDate(ms, 'Europe/London')}, ${formatTime(ms, 'Europe/London')}`,
      'Ada Admin',
      '',
    ]);
    expect(
      within(rows[0] ?? document.body).getByRole('button', {
        name: 'Actions for Service overview',
      }),
    ).toBeInTheDocument();
    expect(await rowTitles()).toEqual(['Service overview', 'Checkout latency', EDGE]);
  });

  it('creates a board and opens it in edit mode', async () => {
    const { user, router } = renderApp('/t/demo/boards');
    await user.click(await screen.findByRole('button', { name: 'New board' }));
    const d = await dialog('New board');
    await user.type(within(d).getByRole('textbox', { name: 'Name' }), 'Latency');
    await user.click(within(d).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(locationOf(router)).toMatch(/^\/t\/demo\/board\/b-4\?/);
    });
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Latency (editing)' }),
    ).toBeVisible();
  });

  it('name is required', async () => {
    const { user, router } = renderApp('/t/demo/boards');
    await user.click(await screen.findByRole('button', { name: 'New board' }));
    const d = await dialog('New board');
    await user.click(within(d).getByRole('button', { name: 'Create' }));
    const name = within(d).getByRole('textbox', { name: 'Name' });
    await waitFor(() => {
      expect(name).toHaveAccessibleDescription('Enter a name');
    });
    expect(router.state.location.pathname).toBe('/t/demo/boards');
  });

  it('renames and deletes', async () => {
    const { user } = renderApp('/t/demo/boards');
    await table();
    await user.click(screen.getByRole('button', { name: 'Actions for Checkout latency' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const r = await dialog('Rename board');
    const name = within(r).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Checkout latency');
    await user.clear(name);
    await user.type(name, 'Checkout p99');
    await user.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      expect(await rowTitles()).toEqual(['Service overview', 'Checkout p99', EDGE]);
    });

    await user.click(screen.getByRole('button', { name: 'Actions for Checkout p99' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const d = await dialog('Delete board?');
    expect(d).toHaveTextContent('“Checkout p99” and its versions will be removed from the list.');
    await user.click(within(d).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => {
      expect(await rowTitles()).toEqual(['Service overview', EDGE]);
    });
  });

  it('empty and truncated', async () => {
    const empty = renderApp('/t/demo/boards', { api: new StubApi(seedWith({ boards: [] })) });
    expect(await screen.findByText('No boards yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New board' })).toBeInTheDocument();
    empty.view.unmount();

    class Truncated extends StubApi {
      override async listBoards(tenant: string, signal?: AbortSignal): Promise<BoardList> {
        return { ...(await super.listBoards(tenant, signal)), truncated: true };
      }
    }
    renderApp('/t/demo/boards', { api: new Truncated() });
    expect(
      await screen.findByText('Showing the 1 000 most recently updated boards'),
    ).toBeInTheDocument();
  });
});

describe('list flow failures', () => {
  it('New: invalid and network', async () => {
    const api = failingApi({
      createBoard: [
        new ApiError('invalid', 'invalid board', [
          { pointer: '/title', messageKey: 'board.title.required' },
        ]),
        new ApiError('network', 'down'),
      ],
    });
    const { user, router } = renderApp('/t/demo/boards', { api });
    await user.click(await screen.findByRole('button', { name: 'New board' }));
    const d = await dialog('New board');
    const name = within(d).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'Latency');
    const create = within(d).getByRole('button', { name: 'Create' });
    await user.click(create);
    await waitFor(() => {
      expect(name).toHaveAccessibleDescription('Enter a name');
    });
    expect(name).toHaveValue('Latency');
    await user.click(create);
    expect(await within(d).findByText('The change could not be saved. Try again.')).toBeVisible();
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/t/demo/board/b-4');
    });
  });

  it('Rename: conflict, then a fresh read', async () => {
    const api = failingApi({ saveBoard: [await conflictFor('b-2')] });
    const { user } = renderApp('/t/demo/boards', { api });
    await table();
    await user.click(screen.getByRole('button', { name: 'Actions for Checkout latency' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const r = await dialog('Rename board');
    const name = within(r).getByRole('textbox', { name: 'Name' });
    await user.type(name, ' 2');
    const save = within(r).getByRole('button', { name: 'Save' });
    await user.click(save);
    expect(
      await within(r).findByText(
        'The board changed while you were renaming it. Save again to rename the latest version.',
      ),
    ).toBeVisible();
    expect(name).toHaveValue('Checkout latency 2');
    expect(save).toBeEnabled();
    const gets = api.calls.filter((c) => c.method === 'getBoard').length;
    await user.click(save);
    await waitFor(async () => {
      expect(await rowTitles()).toContain('Checkout latency 2');
    });
    expect(api.calls.filter((c) => c.method === 'getBoard').length).toBe(gets + 1);
    expect(screen.queryByRole('dialog', { name: 'Rename board' })).toBeNull();
  });

  it('Rename: deleted elsewhere', async () => {
    const api = failingApi({ getBoard: [new ApiError('notFound', 'gone')] });
    const { user } = renderApp('/t/demo/boards', { api });
    await table();
    await user.click(screen.getByRole('button', { name: 'Actions for Checkout latency' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const r = await dialog('Rename board');
    await user.type(within(r).getByRole('textbox', { name: 'Name' }), ' 2');
    await user.click(within(r).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This board was deleted.')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Rename board' })).toBeNull();
    });
  });

  it('Delete: conflict, network, deleted elsewhere', async () => {
    const api = failingApi({
      deleteBoard: [
        await conflictFor('b-2'),
        new ApiError('network', 'down'),
        new ApiError('notFound', 'gone'),
      ],
    });
    const { user } = renderApp('/t/demo/boards', { api });
    await table();
    await user.click(screen.getByRole('button', { name: 'Actions for Checkout latency' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const d = await dialog('Delete board?');
    const del = within(d).getByRole('button', { name: 'Delete' });
    await user.click(del);
    expect(
      await within(d).findByText(
        'The board changed since you opened this dialog. Delete it anyway?',
      ),
    ).toBeVisible();
    await user.click(del);
    expect(await within(d).findByText('The change could not be saved. Try again.')).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Delete board?' })).toBeInTheDocument();
    await user.click(del);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Delete board?' })).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Actions for Checkout latency' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const d2 = await dialog('Delete board?');
    await user.click(within(d2).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => {
      expect(await rowTitles()).toEqual(['Service overview', EDGE]);
    });
  });
});
