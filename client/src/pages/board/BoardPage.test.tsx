import { act, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import type { GridLayoutProps, LayoutItem } from 'react-grid-layout';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { BoardConflictError, type Board, type SaveResult } from '../../api/types';
import { readRecent } from '../../shell/recentBoards';
import {
  deferred,
  EngineWrapper,
  grid,
  gridOf,
  httpApi,
  json,
  panelOf,
  panelTitles,
  stubBoard,
} from '../../test/boardTestKit';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { locationOf, renderApp, type RenderAppOptions } from '../../test/renderApp';
import { seedWith } from '../../test/seeds';

/** The props of every react-grid-layout grid rendered, to simulate a pointer drop. */
const rgl = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock('react-grid-layout', async (importOriginal) => {
  const m = await importOriginal<typeof import('react-grid-layout')>();
  return {
    ...m,
    GridLayout: (p: GridLayoutProps) => {
      rgl.props.push(p);
      return createElement(m.GridLayout, p);
    },
  };
});

beforeEach(() => {
  installResizeObserver();
  rgl.props.length = 0;
});

function open(url: string, o: RenderAppOptions = {}) {
  return renderApp(url, { wrapper: EngineWrapper, ...o });
}

async function editMode(user: ReturnType<typeof open>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Edit board' }));
  await screen.findByRole('button', { name: 'Save' });
}

function liveRegion(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-board-live]');
  if (el === null) throw new Error('no live region');
  return el;
}

function statusLine(): HTMLElement {
  return screen.getByRole('status', { name: 'Save status' });
}

const B1 = ['Request rate', 'Error ratio', 'Errors', 'Request latency'];

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

describe('view mode', () => {
  it('view mode draws panels', async () => {
    open('/t/demo/board/b-1');
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    expect(panelTitles()).toEqual(B1);
    await waitFor(() => {
      expect(document.querySelectorAll('canvas')).toHaveLength(3);
    });
    expect(await screen.findByText('The log stream arrives with LogQL panels')).toBeInTheDocument();
    expect(
      within(panelOf('Errors')).getByText('The log stream arrives with LogQL panels'),
    ).toBeVisible();
    expect(await within(panelOf('Request rate')).findByText('in rps')).toBeVisible();
    expect(gridOf('Request rate')).toBe('0,0,6,8');
    expect(screen.getByRole('heading', { level: 2, name: 'Latency' })).toBeVisible();
  });

  it('BFF mode shows the empty state', async () => {
    const one = open('/t/demo/board/b-1', { api: httpApi() });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    const promql = 'Runs when PromQL support lands';
    for (const title of ['Request rate', 'Error ratio', 'Request latency']) {
      expect(await within(panelOf(title)).findByText(promql), title).toBeVisible();
    }
    expect(
      await within(panelOf('Errors')).findByText('The log stream arrives with LogQL panels'),
    ).toBeVisible();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
    one.view.unmount();

    open('/t/demo/board/b-3', { api: httpApi() });
    await screen.findByRole('heading', { level: 3, name: 'Pods' });
    for (const title of ['Edge p99', 'Pods']) {
      expect(await within(panelOf(title)).findByText(promql), title).toBeVisible();
    }
    expect(
      await within(panelOf('Edge errors')).findByText('Runs when LogQL support lands'),
    ).toBeVisible();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });

  it('max row in both modes', async () => {
    const api = new StubApi(
      seedWith({
        boards: [
          stubBoard('b-9', {
            title: 'Tall',
            panels: [grid(1, [0, 0, 6, 8]), grid(2, [0, 9999, 6, 100])],
            sections: [],
          }),
        ],
      }),
    );
    const { user } = open('/t/demo/board/b-9', { api });
    await screen.findByRole('heading', { level: 3, name: 'p-2' });
    const far = panelOf('p-2');
    expect(far.getAttribute('data-grid')).toBe('0,9999,6,100');
    expect(far.style.getPropertyValue('--gy')).toBe('9999');
    expect(far.style.getPropertyValue('--gh')).toBe('100');
    const container = far.parentElement;
    expect(container?.style.getPropertyValue('--gbottom')).toBe('10099');

    await editMode(user);
    await waitFor(() => {
      expect(document.querySelectorAll('.react-grid-item')).toHaveLength(2);
    });
    const item = panelOf('p-2').closest<HTMLElement>('.react-grid-item');
    expect(item?.style.height).toBe('5584px');
    expect(item?.style.transform).toContain('559944px');
    expect(gridOf('p-2')).toBe('0,9999,6,100');

    const move = screen.getByRole('button', { name: 'Move or resize: p-2' });
    move.focus();
    await user.keyboard('{ArrowDown}');
    expect(gridOf('p-2')).toBe('0,9999,6,100');
    expect(liveRegion()).toHaveTextContent('p-2: blocked at column 1, row 10000, 6 × 100');

    const props = rgl.props.at(-1) as GridLayoutProps;
    const dropped: LayoutItem[] = (props.layout ?? []).map((l) =>
      l.i === 'p-2' ? { ...l, y: 10000 } : l,
    );
    const p2 = dropped.find((l) => l.i === 'p-2') ?? null;
    act(() => {
      props.onDragStop?.(dropped, p2, p2, null, new MouseEvent('mouseup'), null);
    });
    expect(gridOf('p-2')).toBe('0,9999,6,100');
    expect(gridOf('p-1')).toBe('0,0,6,8');
    expect(liveRegion()).toHaveTextContent('p-2: blocked at column 1, row 10000, 6 × 100');
  });
});

describe('edit mode', () => {
  it('edit, add, title, save', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    const editor = await screen.findByRole('complementary', { name: 'Panel editor' });
    await user.type(within(editor).getByRole('textbox', { name: 'Title' }), 'A');
    await user.click(within(editor).getByRole('button', { name: /Visualisation$/ }));
    await user.click(await screen.findByRole('option', { name: 'Stat' }));
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(save).toHaveBeenCalledTimes(1);
    const [tenant, uid, etag, draft] = save.mock.calls[0] ?? [];
    expect([tenant, uid, etag]).toEqual(['demo', 'b-1', '1']);
    expect(draft?.panels.at(-1)).toMatchObject({
      id: 'p-5',
      title: 'A',
      grid: { x: 0, y: 18, w: 6, h: 8 },
      vis: { kind: 'stat' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Shift+E enters and leaves edit', async () => {
    const { user } = open('/t/demo/board/b-1');
    await screen.findByRole('button', { name: 'Edit board' });
    await user.keyboard('{Shift>}E{/Shift}');
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
    await user.keyboard('{Shift>}E{/Shift}');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
  });

  it('keyboard move and resize', async () => {
    const { user } = open('/t/demo/board/b-3');
    await editMode(user);
    const move = await screen.findByRole('button', { name: 'Move or resize: Pods' });
    move.focus();
    for (let i = 0; i < 6; i++) await user.keyboard('{ArrowRight}');
    for (let i = 0; i < 2; i++) await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(gridOf('Pods')).toBe('6,8,6,10');
    expect(liveRegion()).toHaveTextContent('Pods: column 7, row 9, 6 × 10');
  });

  it('board is full', async () => {
    const tall = Array.from({ length: 100 }, (_, i) => grid(i + 1, [0, i * 100, 12, 100]));
    const many = Array.from({ length: 200 }, (_, i) =>
      grid(i + 1, [i % 12, Math.floor(i / 12), 1, 1]),
    );
    const api = new StubApi(
      seedWith({
        boards: [
          stubBoard('b-8', { title: 'Full', panels: tall, sections: [] }),
          stubBoard('b-9', { title: 'Many', panels: many, sections: [] }),
        ],
      }),
    );
    const full = open('/t/demo/board/b-8', { api });
    await editMode(full.user);
    await full.user.click(screen.getByRole('button', { name: 'Add panel' }));
    const noSpace = 'Board is full: no space for a 6 × 8 panel';
    expect(liveRegion()).toHaveTextContent(noSpace);
    expect(statusLine()).toHaveTextContent(noSpace);
    expect(panelTitles()).toHaveLength(100);
    full.view.unmount();

    const many200 = open('/t/demo/board/b-9', { api });
    await editMode(many200.user);
    await many200.user.click(screen.getByRole('button', { name: 'Add panel' }));
    expect(liveRegion()).toHaveTextContent('Board is full: at most 200 panels');
    expect(panelTitles()).toHaveLength(200);
  });

  it('discard reloads the head', async () => {
    const api = new StubApi();
    const get = vi.spyOn(api, 'getBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    expect(panelTitles()).toHaveLength(5);
    const before = get.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('button', { name: 'Edit board' })).toBeInTheDocument();
    expect(get.mock.calls.length).toBeGreaterThan(before);
    expect(panelTitles()).toEqual(B1);
  });

  it('read-only while saving', async () => {
    const api = new StubApi();
    const pending = deferred<SaveResult>();
    vi.spyOn(api, 'saveBoard').mockImplementation(() => pending.promise);
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    const editor = await screen.findByRole('complementary', { name: 'Panel editor' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    for (const name of ['Save', 'Add panel', 'Discard', 'Done']) {
      expect(screen.getByRole('button', { name }), name).toBeDisabled();
    }
    for (const b of screen.getAllByRole('button', { name: /^Move or resize: / })) {
      expect(b).toBeDisabled();
    }
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveAttribute('readonly');
    await user.type(title, 'x');
    expect(title).toHaveValue('');

    const head = await api.getBoard('demo', 'b-1');
    const spec = { ...head.spec, title: 'Saved by the server' };
    await act(async () => {
      pending.resolve({
        board: { ...head, version: 2, etag: '2', title: spec.title, spec },
        changed: true,
      });
      await pending.promise;
    });
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(panelTitles()).toEqual(B1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Saved by the server');
  });
});

describe('navigation and time', () => {
  it('guard on navigation', async () => {
    const { user, router } = open('/t/demo/board/b-1');
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    const nav = screen.getByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: 'Boards' }));
    const guard = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(guard).getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe('/t/demo/board/b-1');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(panelTitles()).toHaveLength(5);
    await user.click(within(nav).getByRole('link', { name: 'Boards' }));
    const again = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(again).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/t/demo/boards');
    });
  });

  it('guard ignores time changes', async () => {
    const { user, router } = open('/t/demo/board/b-1');
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: /^Last 1 hour/ }),
    );
    await user.click(await screen.findByRole('option', { name: 'Last 6 hours' }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('from=now-6h');
    });
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    const before = router.state.location.search;
    await user.keyboard(']');
    await waitFor(() => {
      expect(router.state.location.search).not.toBe(before);
    });
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(panelTitles()).toHaveLength(5);
  });

  it('saved time applied from links', async () => {
    const { user, router } = open('/t/demo/boards?from=now-1h&to=now&refresh=off');
    const table = await screen.findByRole('table', { name: 'All boards' });
    await user.click(within(table).getByRole('link', { name: 'Service overview' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?from=now-6h&to=now&refresh=off');
    });
    expect(router.state.location.pathname).toBe('/t/demo/board/b-1');
    expect(router.state.location.state).toBeNull();
  });

  it('deep link keeps URL time', async () => {
    const { router } = open('/t/demo/board/b-1?from=now-1h&to=now&refresh=off');
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    await screen.findByRole('button', { name: 'Edit board' });
    expect(locationOf(router)).toBe('/t/demo/board/b-1?from=now-1h&to=now&refresh=off');
  });

  it('save current time range', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-2?from=now-3h&to=now&refresh=off', { api });
    await editMode(user);
    const box = screen.getByRole('checkbox', { name: 'Save current time range' });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(save.mock.calls[0]?.[3].time).toEqual({ from: 'now-3h', to: 'now' });
    await user.click(screen.getByRole('checkbox', { name: 'Save current time range' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    });
    expect(save.mock.calls[1]?.[3]).not.toHaveProperty('time');
  });
});

/** A stub whose second and later `getBoard` of b-1 wait for `next`, a v2 head of 3 panels. */
class RemoteSaveApi extends StubApi {
  readonly next = deferred<undefined>();
  private reads = 0;
  remote: Board | null = null;

  override async getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<Board> {
    const b = await super.getBoard(tenant, uid, signal);
    this.reads += 1;
    if (this.reads === 1 || uid !== 'b-1') return b;
    await this.next.promise;
    this.remote = {
      ...b,
      version: 2,
      etag: '2',
      spec: { ...b.spec, panels: b.spec.panels.slice(0, 2) },
    };
    return this.remote;
  }

  override saveBoard(tenant: string, uid: string, etag: string, spec: Board['spec']) {
    if (this.remote !== null && etag !== this.remote.etag) {
      return Promise.reject(new BoardConflictError(this.remote));
    }
    return super.saveBoard(tenant, uid, etag, spec);
  }
}

describe('saving', () => {
  it('conflict: keep mine', async () => {
    localStorage.setItem('pulsus-dash.stub.conflictSave', '1');
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const d = await screen.findByRole('dialog', { name: 'This board was changed' });
    expect(d).toHaveTextContent('Someone saved version 2 after you opened it.');
    const theirs = await api.getBoard('demo', 'b-1');
    expect([theirs.version, theirs.spec.panels.length]).toEqual([2, 3]);
    await user.click(within(d).getByRole('button', { name: 'Save mine as a new version' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[2]).toBe('2');
    const mine = await api.getBoard('demo', 'b-1');
    expect(mine.version).toBe(3);
    expect(mine.spec.panels).toHaveLength(4);
    expect(panelTitles()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('conflict: take theirs', async () => {
    localStorage.setItem('pulsus-dash.stub.conflictSave', '1');
    const { user } = open('/t/demo/board/b-1');
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const d = await screen.findByRole('dialog', { name: 'This board was changed' });
    await user.click(within(d).getByRole('button', { name: 'Discard mine and load theirs' }));
    await waitFor(() => {
      expect(panelTitles()).toEqual(B1);
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('refetch while dirty', async () => {
    const api = new RemoteSaveApi();
    const { user, queryClient } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    await act(async () => {
      api.next.resolve(undefined);
      await api.next.promise;
    });
    expect(
      await screen.findByText(
        'This board was saved elsewhere (version 2). Saving will ask which version to keep.',
      ),
    ).toBeVisible();
    expect(panelTitles()).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: 'This board was changed' })).toBeVisible();
  });

  it('refetch while clean', async () => {
    const api = new RemoteSaveApi();
    const { queryClient } = open('/t/demo/board/b-1', { api });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    await act(async () => {
      api.next.resolve(undefined);
      await api.next.promise;
    });
    await waitFor(() => {
      expect(panelTitles()).toEqual(['Request rate', 'Error ratio', 'Request latency']);
    });
  });

  it('server invalid', async () => {
    const api = httpApi(() =>
      Promise.resolve(
        json(400, {
          error: {
            code: 'invalid',
            message: 'invalid board',
            fields: [{ pointer: '/panels/0/title', message_key: 'board.panel.title.tooLong' }],
          },
        }),
      ),
    );
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Problems to fix before saving: 1');
    });
    const editor = screen.getByRole('complementary', { name: 'Panel editor' });
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Request rate');
    expect(title).toHaveAccessibleDescription('Use at most 200 characters');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('save after delete elsewhere', async () => {
    const api = httpApi(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'board not found' } })),
    );
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent(
        'This board was deleted elsewhere. Your changes are not saved.',
      );
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(panelTitles()).toHaveLength(5);
  });

  it('invalid save', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    const editor = await screen.findByRole('complementary', { name: 'Panel editor' });
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    await user.click(title);
    await user.paste('x'.repeat(201));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Problems to fix before saving: 1');
    });
    expect(title).toHaveAccessibleDescription('Use at most 200 characters');
    expect(save).not.toHaveBeenCalled();
  });

  it('failed save keeps the draft', async () => {
    localStorage.setItem('pulsus-dash.stub.failSave', '1');
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    const button = screen.getByRole('button', { name: 'Save' });
    await user.click(button);
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Could not save. Your changes are kept.');
    });
    expect(button).toBeEnabled();
    expect(panelTitles()).toHaveLength(5);
    await user.click(button);
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(save.mock.calls.map((c) => c[2])).toEqual(['1', '1']);
  });
});

describe('panel tools', () => {
  it('full screen and menu', async () => {
    const { user } = open('/t/demo/board/b-1');
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    const full = screen.getByRole('button', { name: 'Full screen: Request rate' });
    await user.click(full);
    const d = await screen.findByRole('dialog', { name: 'Request rate' });
    await waitFor(() => {
      expect(d.querySelector('canvas')).not.toBeNull();
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Request rate' })).toBeNull();
    });
    // React Aria restores focus a frame after the dialog unmounts.
    await waitFor(() => {
      expect(full).toHaveFocus();
    });
    await user.click(screen.getByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy query' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe('sum(rate(http_requests_total[5m]))');
    });
  });

  it('explore link', async () => {
    open('/t/demo/board/b-1');
    const link = await screen.findByRole('link', { name: 'Open in Explore: Errors' });
    expect(link).toHaveAttribute(
      'href',
      '/t/demo/explore/logs?from=now-1h&to=now&refresh=off&q=%7Bapp%3D%22api%22%7D%20%7C%3D%20%22error%22',
    );
  });
});
