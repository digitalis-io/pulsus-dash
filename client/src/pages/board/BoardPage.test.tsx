import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import type { GridLayoutProps, LayoutItem } from 'react-grid-layout';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { stubPanelData } from '../../api/stubPanels';
import {
  ApiError,
  BoardConflictError,
  type Board,
  type PanelData,
  type PanelSpec,
  type SaveResult,
  type TimeWindow,
} from '../../api/types';
import type { FrameData } from '../../engine/api';
import header from '../../shell/Header.module.css';
import { failingApi } from '../../test/failingApi';
import {
  deferred,
  engineWrapper,
  EngineWrapper,
  grid,
  gridOf,
  httpApi,
  json,
  panelOf,
  panelTitles,
  stubBoard,
} from '../../test/boardTestKit';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../../test/fakeEngine';
import { installResizeObserver, resizeOf } from '../../test/fakeResizeObserver';
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

async function editorDialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Edit panel' });
}

/** Add panel, then close the editor it opens (#90, Appendix A R1). */
async function addPanel(user: ReturnType<typeof open>['user'], name = 'Add panel') {
  await user.click(screen.getByRole('button', { name }));
  const d = await editorDialog();
  await user.click(within(d).getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
  });
}

const B1 = ['Request rate', 'Error ratio', 'Errors', 'Request latency'];

/** Links between a sidebar group heading and the next heading. */
function linksAfter(heading: HTMLElement): string[] {
  const out: string[] = [];
  let el = heading.nextElementSibling;
  while (el !== null && el.tagName !== 'H2') {
    for (const a of el.querySelectorAll('a')) out.push(a.textContent.replace('★', ''));
    el = el.nextElementSibling;
  }
  return out;
}

/** The uids of the stub's stored Recent entries, newest first. */
function recentUids(): string[] {
  const raw = localStorage.getItem('pulsus-dash.stub.recent');
  if (raw === null) return [];
  return (JSON.parse(raw) as { uid: string }[]).map((e) => e.uid);
}

describe('star toggle', () => {
  it('star toggle', async () => {
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
    await waitFor(() => {
      expect(linksAfter(within(nav).getByRole('heading', { name: 'Starred' }))).toContain(
        'Checkout latency',
      );
    });
    expect(localStorage.getItem('pulsus-dash.stub.starred')).toBe('["b-1","b-2"]');
    await user.click(star);
    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'false');
    });
    expect(recentUids()).toEqual(['b-2']);
    await waitFor(() => {
      expect(linksAfter(within(nav).getByRole('heading', { name: 'Recent' }))[0]).toBe(
        'Checkout latency',
      );
    });
  });

  it('star failure', async () => {
    const api = failingApi({ setStarred: [new ApiError('network', 'x')] });
    const { user } = renderApp('/t/demo/board/b-2', { api });
    const star = await screen.findByRole('button', { name: 'Star board' });
    await waitFor(() => {
      expect(star).toBeEnabled();
    });
    const status = star.nextElementSibling;
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('');
    await user.click(star);
    await waitFor(() => {
      expect(status).toHaveTextContent('Could not update Starred. Try again.');
    });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    expect(status?.tagName).toBe('SPAN');
    expect(status).toHaveClass(header['starStatus'] ?? 'starStatus');
    expect(status?.className).not.toMatch(/visuallyHidden/);
    await user.click(star);
    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'true');
    });
    expect(status).toHaveTextContent('');
  });

  it('records a view once', async () => {
    const api = new StubApi();
    const record = vi.spyOn(api, 'recordView');
    const before = Date.now();
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await addPanel(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(record).toHaveBeenCalledTimes(1);
    const [tenant, uid, at, signal] = record.mock.calls[0] ?? [];
    expect([tenant, uid]).toEqual(['demo', 'b-1']);
    expect(Number.isInteger(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(signal).toBeInstanceOf(AbortSignal);

    cleanup();
    const failing = failingApi({ recordView: [new ApiError('notFound', 'gone')] });
    open('/t/demo/board/b-1', { api: failing });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    await waitFor(() => {
      expect(failing.calls.some((c) => c.method === 'recordView')).toBe(true);
    });
    expect(panelTitles()).toHaveLength(4);
    expect(screen.queryByText(/Could not/)).toBeNull();
  });

  it('rapid board changes keep the latest first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const api = new GatedRecentApi();
      const { router } = renderApp('/t/demo/board/b-1', { api });
      await screen.findByRole('heading', { level: 1, name: 'Service overview' });
      await waitFor(() => {
        expect(api.sent).toContain('b-1');
      });
      await act(() => router.navigate('/t/demo/board/b-2'));
      await screen.findByRole('heading', { level: 1, name: 'Checkout latency' });
      const recent = () =>
        linksAfter(
          within(screen.getByRole('navigation', { name: 'Main' })).getByRole('heading', {
            name: 'Recent',
          }),
        );
      await waitFor(() => {
        expect(recent()).toEqual(['Checkout latency']);
      });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(api.aborted).toBe(true);
      // b-1 commits after its client timeout and after b-2's refresh.
      await act(async () => {
        api.gate.resolve(undefined);
        await api.committed;
      });
      expect(recentUids()).toEqual(['b-2', 'b-1']);
      expect(recent()).toEqual(['Checkout latency']);
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      await waitFor(() => {
        expect(recent()).toEqual(['Checkout latency', 'Service overview']);
      });
    } finally {
      vi.useRealTimers();
    }
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
    const editor = await editorDialog();
    await user.type(within(editor).getByRole('textbox', { name: 'Title' }), 'A');
    await user.click(within(editor).getByRole('button', { name: /Visualisation$/ }));
    await user.click(await screen.findByRole('option', { name: 'Stat' }));
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(within(editor).getByRole('status', { name: 'Save status' })).toHaveTextContent(
        'Saved',
      );
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
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).toBeDisabled();
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
    await addPanel(user);
    expect(panelTitles()).toHaveLength(5);
    const before = get.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('button', { name: 'Edit board' })).toBeInTheDocument();
    expect(get.mock.calls.length).toBeGreaterThan(before);
    expect(panelTitles()).toEqual(B1);
  });

  it('discard is exclusive while it reloads', async () => {
    const api = new GatedReadApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await addPanel(user);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    for (const name of ['Save', 'Add panel', 'Discard', 'Done']) {
      expect(screen.getByRole('button', { name }), name).toBeDisabled();
    }
    for (const b of screen.getAllByRole('button', { name: /^Move or resize: / })) {
      expect(b).toBeDisabled();
    }
    // The added panel, so the Title assertions below stay as they were (an empty title).
    await user.click(screen.getByRole('button', { name: 'Panel menu: Untitled panel' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const editor = await editorDialog();
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveAttribute('readonly');
    await user.type(title, 'x');
    expect(title).toHaveValue('');
    await user.keyboard('{Control>}s{/Control}');
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      api.next.resolve(undefined);
      await api.next.promise;
    });
    expect(await screen.findByRole('button', { name: 'Edit board' })).toBeInTheDocument();
    expect(panelTitles()).toEqual(B1);
    expect(save).not.toHaveBeenCalled();
  });

  it('failed discard keeps the draft editable', async () => {
    const api = new GatedReadApi(new ApiError('network', 'x'));
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await addPanel(user);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await act(async () => {
      api.next.resolve(undefined);
      await api.next.promise;
    });
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent(
        'Could not discard: the saved version did not load. Your changes are kept.',
      );
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(panelTitles()).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Panel menu: Untitled panel' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const editor = await editorDialog();
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    expect(title).not.toHaveAttribute('readonly');
    await user.type(title, 'A');
    expect(title).toHaveValue('A');
    await user.click(within(editor).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    for (const name of ['Discard', 'Add panel', 'Done', 'Save']) {
      expect(screen.getByRole('button', { name }), name).toBeEnabled();
    }
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Shift+E while Discard is pending', async () => {
    const api = new GatedReadApi();
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await addPanel(user);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Shift>}E{/Shift}');
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(panelTitles()).toHaveLength(5);
    await act(async () => {
      api.next.resolve(undefined);
      await api.next.promise;
    });
    expect(await screen.findByRole('button', { name: 'Edit board' })).toBeInTheDocument();
    expect(panelTitles()).toEqual(B1);
  });

  it('read-only while saving', async () => {
    const api = new StubApi();
    const pending = deferred<SaveResult>();
    vi.spyOn(api, 'saveBoard').mockImplementation(() => pending.promise);
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    const editor = await editorDialog();
    await user.keyboard('{Control>}s{/Control}');
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveAttribute('readonly');
    await user.type(title, 'x');
    expect(title).toHaveValue('');
    expect(within(editor).getByRole('button', { name: 'Remove panel' })).toBeDisabled();
    expect(within(editor).getByRole('button', { name: 'Done' })).toBeEnabled();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    for (const name of ['Save', 'Add panel', 'Discard', 'Done']) {
      expect(screen.getByRole('button', { name }), name).toBeDisabled();
    }
    for (const b of screen.getAllByRole('button', { name: /^Move or resize: / })) {
      expect(b).toBeDisabled();
    }

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
    await addPanel(user);
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
    await addPanel(user);
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
    await addPanel(user);
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
    await addPanel(user);
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
    await addPanel(user);
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

  it.each([
    ['deleted elsewhere', new ApiError('notFound', 'board not found'), 'board.reloadGone'],
    ['network failure', new ApiError('network', 'offline'), 'board.reloadFailed'],
  ] as const)('failed refetch while dirty keeps the draft: %s', async (_, error, key) => {
    const text = {
      'board.reloadGone':
        'This board was deleted elsewhere. Your changes are kept here but cannot be saved.',
      'board.reloadFailed': 'Could not reload this board. Your changes are kept.',
    }[key];
    const api = new GatedReadApi(error);
    const { user, queryClient } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await addPanel(user);
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    await act(async () => {
      api.next.resolve(undefined);
      await api.next.promise;
    });
    expect(await screen.findByText(text, {}, { timeout: 4000 })).toBeVisible();
    expect(panelTitles()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: 'Boards' }));
    expect(
      await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
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
    await addPanel(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const editor = await editorDialog();
    await waitFor(() => {
      expect(within(editor).getByRole('status', { name: 'Save status' })).toHaveTextContent(
        'Problems to fix before saving: 1',
      );
    });
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Request rate');
    expect(title).toHaveAccessibleDescription('Use at most 200 characters');
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).toBeEnabled();
  });

  it('save after delete elsewhere', async () => {
    const api = httpApi(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'board not found' } })),
    );
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await addPanel(user);
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
    const editor = await editorDialog();
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    await user.click(title);
    await user.paste('x'.repeat(201));
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(within(editor).getByRole('status', { name: 'Save status' })).toHaveTextContent(
        'Problems to fix before saving: 1',
      );
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
    await addPanel(user);
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

describe('refresh', () => {
  it('BoardPage refresh leaves panel queries', async () => {
    const api = new HeldPanelApi();
    const { user } = open(
      '/t/demo/board/b-1?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off',
      { api },
    );
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    await waitFor(() => {
      expect(api.held.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(api.held).toHaveLength(B1.length);
    });
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await act(async () => {
      await new Promise((r) => {
        setTimeout(r, 0);
      });
    });
    expect(api.held.map((h) => h.signal?.aborted ?? false)).toEqual(B1.map(() => false));
    expect(api.held).toHaveLength(B1.length);
    await act(async () => {
      for (const h of api.held) h.release();
      await Promise.resolve();
    });
    // The released data reaches every chart panel (its frame mounts; with #90 a chart panel keeps
    // its Loading until the engine has drawn, which the fake engine never reports).
    await waitFor(() => {
      expect(document.querySelectorAll('canvas')).toHaveLength(3);
    });
  });
});

/** A stub whose `panelData` calls wait until the test releases them; each keeps its signal. */
class HeldPanelApi extends StubApi {
  readonly held: { signal: AbortSignal | undefined; release: () => void }[] = [];

  override panelData(...a: Parameters<StubApi['panelData']>): ReturnType<StubApi['panelData']> {
    const [tenant, panel, window, signal] = a;
    const gate = deferred<undefined>();
    this.held.push({
      signal,
      release: () => {
        gate.resolve(undefined);
      },
    });
    return gate.promise.then(() => super.panelData(tenant, panel, window));
  }
}

/**
 * A stub whose second and later `getBoard` of b-1 wait for `next`, then return the head again or,
 * given `fail`, reject with it.
 */
class GatedReadApi extends StubApi {
  readonly next = deferred<undefined>();
  private reads = 0;

  constructor(private readonly fail: ApiError | null = null) {
    super();
  }

  override async getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<Board> {
    const b = await super.getBoard(tenant, uid, signal);
    this.reads += 1;
    if (this.reads === 1 || uid !== 'b-1') return b;
    await this.next.promise;
    if (this.fail !== null) throw this.fail;
    return b;
  }
}

/**
 * A stub whose `recordView` of b-1 rejects with `AbortError` when its signal aborts, and writes the
 * view (the stub's greater-time-wins write) only when the test opens `gate`, modelling a server
 * that commits after the client gave up. It never touches the query client.
 */
class GatedRecentApi extends StubApi {
  readonly gate = deferred<undefined>();
  readonly sent: string[] = [];
  aborted = false;
  committed: Promise<void> = Promise.resolve();

  override recordView(tenant: string, uid: string, at: number, signal?: AbortSignal) {
    this.sent.push(uid);
    if (uid !== 'b-1') return super.recordView(tenant, uid, at, signal);
    const write = () => super.recordView(tenant, uid, at);
    this.committed = this.gate.promise.then(write);
    return new Promise<void>((resolve, reject) => {
      signal?.addEventListener('abort', () => {
        this.aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
      this.committed.then(resolve, reject);
    });
  }
}

/** A `panelData` call held by `gated()` until the test settles it. */
interface Held {
  panel: PanelSpec;
  window: TimeWindow;
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (e: Error) => void;
}

function frameDataOf(d: PanelData): FrameData {
  if (d.kind !== 'frame') throw new Error(`no frame data: ${d.kind}`);
  return d.data;
}

describe('panel editor dialog', () => {
  const LOGS = 'The log stream arrives with LogQL panels';

  /** Runs `fn` (a held call settling) in `act`, then lets its promise callbacks run. */
  const settle = (fn: () => void): Promise<void> =>
    act(async () => {
      fn();
      await Promise.resolve();
    });

  /** The shared setup (plan §5.1): a stub, a `panelData` spy, a fake engine, b-1 in Edit mode. */
  async function setup(o: { edit?: boolean } = {}) {
    const api = new StubApi();
    const spy = vi.spyOn(api, 'panelData');
    const save = vi.spyOn(api, 'saveBoard');
    const engine: FakeEngine = fakeEngine();
    // Frames created inside the preview, kept after their disposal (`drawnKinds`).
    const previewFrames = new Set<FakeFrame>();
    const create = engine.createFrame.bind(engine);
    engine.createFrame = (canvas, init) => {
      const f = create(canvas, init) as FakeFrame;
      if (canvas.closest('[data-panel-preview]') !== null) previewFrames.add(f);
      return f;
    };
    const r = open('/t/demo/board/b-1', { api, wrapper: engineWrapper(engine) });
    if (o.edit !== false) {
      await editMode(r.user);
      // The Edit grid is a lazy chunk: its panels replace the fallback's once it has loaded.
      await waitFor(() => {
        expect(document.querySelectorAll('.react-grid-item')).toHaveLength(4);
      });
    }
    const { user } = r;

    const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Edit panel' });
    const openOn = async (title: string): Promise<HTMLElement> => {
      await user.click(await screen.findByRole('button', { name: `Panel menu: ${title}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
      return screen.findByRole('dialog', { name: 'Edit panel' });
    };
    const preview = (): HTMLElement => within(dialog()).getByRole('region', { name: 'Preview' });
    const previewHost = (): HTMLElement => {
      const el = preview().querySelector<HTMLElement>('[data-preview-host]');
      if (el === null) throw new Error('no preview host');
      return el;
    };
    const previewFrame = (): FakeFrame => {
      const p = preview();
      const f = engine.frames.findLast((x) => x.disposed === 0 && p.contains(x.canvas));
      if (f === undefined) throw new Error('no preview frame');
      return f;
    };
    const chartHost = (): HTMLElement => {
      const el = preview().querySelector<HTMLElement>('[data-chart-frame]');
      if (el === null) throw new Error('no preview chart');
      return el;
    };
    const showPreview = (): void => {
      act(() => {
        resizeOf(chartHost(), 760, 240);
      });
      act(() => {
        previewFrame().draw();
      });
    };
    const kindOf = (f: FakeFrame): string | undefined =>
      (f.last('setSpec')?.[0] as { kind?: string } | undefined)?.kind;
    const waitKind = async (kind: string): Promise<void> => {
      await waitFor(() => {
        expect(kindOf(previewFrame())).toBe(kind);
      });
      showPreview();
    };
    const resizes = (f: FakeFrame) =>
      f.calls.filter((c) => c.method === 'resize').map((c) => c.args);
    const calls = (pred: (p: PanelSpec) => boolean) => spy.mock.calls.filter((c) => pred(c[1]));
    const vis = async (label: string): Promise<void> => {
      await user.click(within(dialog()).getByRole('button', { name: /Visualisation$/ }));
      await user.click(await screen.findByRole('option', { name: label }));
    };
    const gated = (): Held[] => {
      const held: Held[] = [];
      spy.mockImplementation(
        (_tenant, panel, window, signal) =>
          new Promise<PanelData>((res, rej) => {
            held.push({
              panel,
              window,
              signal,
              resolve: () => {
                res(stubPanelData(panel, window));
              },
              reject: (e) => {
                rej(e);
              },
            });
          }),
      );
      return held;
    };
    /** Every `setSpec` kind on preview frames since `mark()` was taken. */
    const mark = () => new Map([...previewFrames].map((f) => [f, f.calls.length] as const));
    const drawnKinds = (since: Map<FakeFrame, number>): string[] =>
      [...previewFrames].flatMap((f) =>
        f.calls
          .slice(since.get(f) ?? 0)
          .filter((c) => c.method === 'setSpec')
          .map((c) => (c.args[0] as { kind: string }).kind),
      );
    const pendingShown = (): boolean => preview().querySelector('[data-chart-pending]') !== null;
    /** The preview shows a chart and no `PanelBody` message. */
    const chartOnly = (): void => {
      const kids = [...previewHost().children];
      expect(kids).toHaveLength(1);
      expect(kids[0]?.matches('[data-chart-frame]')).toBe(true);
    };
    const firstCallData = (kind: string): FrameData => {
      const c = calls((p) => p.id === 'p-1' && p.vis.kind === kind)[0];
      if (c === undefined) throw new Error(`no ${kind} call`);
      return frameDataOf(stubPanelData(c[1], c[2]));
    };
    return {
      ...r,
      api,
      spy,
      save,
      engine,
      dialog,
      openOn,
      preview,
      previewHost,
      previewFrame,
      chartHost,
      showPreview,
      waitKind,
      resizes,
      calls,
      vis,
      gated,
      mark,
      drawnKinds,
      pendingShown,
      chartOnly,
      firstCallData,
    };
  }

  // Appendix B §B.6: the dialog rows.

  it('editor is a modal dialog', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    expect(screen.queryByRole('complementary', { name: 'Panel editor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).toBeInTheDocument();
    expect(t.preview()).toBeInTheDocument();
    const fields = [
      within(d).getByRole('textbox', { name: 'Title' }),
      within(d).getByRole('button', { name: /Query language$/ }),
      within(d).getByRole('textbox', { name: 'Query' }),
      within(d).getByRole('button', { name: /Visualisation$/ }),
    ];
    for (let i = 1; i < fields.length; i++) {
      const a = fields[i - 1];
      const b = fields[i];
      if (a === undefined || b === undefined) throw new Error('missing field');
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('Esc closes; focus returns to the Panel menu', async () => {
    const t = await setup();
    await t.openOn('Request rate');
    await t.user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Panel menu: Request rate' })).toHaveFocus();
    });
  });

  it('Done closes; draft kept', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    await t.user.type(within(d).getByRole('textbox', { name: 'Title' }), 'X');
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    expect(panelTitles()[0]).toBe('Request rateX');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Panel menu: Request rateX' })).toHaveFocus();
    });
  });

  it('added panel: focus returns to its menu', async () => {
    const t = await setup();
    await t.user.click(screen.getByRole('button', { name: 'Add panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    await t.user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Panel menu: Untitled panel' })).toHaveFocus();
    });
  });

  it('remove panel: focus goes to Add panel', async () => {
    const t = await setup();
    const d = await t.openOn('Errors');
    await t.user.click(within(d).getByRole('button', { name: 'Remove panel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    expect(panelTitles()).not.toContain('Errors');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add panel' })).toHaveFocus();
    });
  });

  it('focus stays in the dialog', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    for (let i = 0; i < 12; i++) {
      await t.user.tab();
      expect(d.contains(document.activeElement), `tab ${String(i)}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await t.user.tab({ shift: true });
      expect(d.contains(document.activeElement), `shift+tab ${String(i)}`).toBe(true);
    }
  });

  it('Mod+S from the dialog', async () => {
    const t = await setup();
    await t.user.click(screen.getByRole('button', { name: 'Add panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    await t.user.type(within(d).getByRole('textbox', { name: 'Title' }), 'A');
    await t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(within(d).getByRole('status', { name: 'Save status' })).toHaveTextContent('Saved');
    });
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Edit panel' })).toBe(d);
  });

  it('Shift+E is ignored in the dialog', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    act(() => {
      within(d).getByRole('button', { name: 'Done' }).focus();
    });
    await t.user.keyboard('{Shift>}E{/Shift}');
    expect(screen.getByRole('dialog', { name: 'Edit panel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).toBeInTheDocument();
  });

  it('field errors show in the dialog', async () => {
    const t = await setup();
    await t.user.click(screen.getByRole('button', { name: 'Add panel' }));
    const first = await screen.findByRole('dialog', { name: 'Edit panel' });
    await t.user.click(within(first).getByRole('textbox', { name: 'Title' }));
    await t.user.paste('x'.repeat(201));
    await t.user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    expect(within(d).getByRole('textbox', { name: 'Title' })).toHaveAccessibleDescription(
      'Use at most 200 characters',
    );
    expect(within(d).getByRole('status', { name: 'Save status' })).toHaveTextContent(
      'Problems to fix before saving: 1',
    );
  });

  // Plan §5.1: AC2 and readiness.

  it("title: in the change's commit", async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    act(() => {
      fireEvent.change(within(d).getByRole('textbox', { name: 'Title' }), {
        target: { value: 'Q' },
      });
    });
    expect(t.preview().querySelector('[data-preview-title]')).toHaveTextContent(/^Q$/);
    expect(t.preview().querySelector('canvas')?.getAttribute('aria-label')).toMatch(/^Q/);
    expect(t.previewFrame().last('setSpec')?.[0]).toMatchObject({ title: 'Q' });
  });

  it('visualisation: from the cache at once', async () => {
    const t = await setup();
    await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    await t.vis('Bars');
    await t.waitKind('bars');
    await t.vis('Stat');
    await t.waitKind('stat');
    const n = t.spy.mock.calls.length;
    for (const [label, kind, newFrame] of [
      ['Line', 'line', true],
      ['Bars', 'bars', false],
      ['Stat', 'stat', true],
    ] as const) {
      const before = t.previewFrame();
      await t.vis(label);
      expect(t.spy.mock.calls.length, label).toBe(n);
      t.chartOnly();
      const f = t.previewFrame();
      expect(f.last('setSpec')?.[0], label).toMatchObject({ kind });
      expect(f.last('setData')?.[0], label).toEqual(t.firstCallData(kind));
      if (newFrame) {
        expect(f, label).not.toBe(before);
        expect(t.resizes(f), label).toEqual([[760, 240, 1]]);
      } else {
        expect(f, label).toBe(before);
      }
      expect(t.pendingShown(), label).toBe(true);
      act(() => {
        f.draw();
      });
      expect(t.pendingShown(), label).toBe(false);
    }
  });

  it('visualisation: progress, then the result', async () => {
    const t = await setup();
    await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    const held = t.gated();
    await t.vis('Heatmap');
    expect(held).toHaveLength(1);
    expect(held[0]?.panel.vis.kind).toBe('heatmap');
    expect(within(t.preview()).getByText('Loading')).toBeInTheDocument();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
    await settle(() => {
      held[0]?.resolve();
    });
    await waitFor(() => {
      expect(t.previewFrame().last('setSpec')?.[0]).toMatchObject({ kind: 'heatmap' });
    });
    const h0 = held[0];
    if (h0 === undefined) throw new Error('no call');
    const f = t.previewFrame();
    expect(f.last('setData')?.[0]).toEqual(frameDataOf(stubPanelData(h0.panel, h0.window)));
    expect(t.resizes(f)).toEqual([[760, 240, 1]]);
    expect(t.pendingShown()).toBe(true);
    act(() => {
      resizeOf(t.chartHost(), 760, 240);
    });
    expect(t.resizes(f)).toHaveLength(1);
    expect(t.pendingShown()).toBe(true);
    act(() => {
      f.draw();
    });
    expect(t.pendingShown()).toBe(false);
  });

  it('visualisation: a failed load shows the error state', async () => {
    const t = await setup();
    await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    const held = t.gated();
    await t.vis('Stat');
    await settle(() => {
      held[0]?.reject(new ApiError('network', 'x'));
    });
    expect(await within(t.preview()).findByText('Something went wrong')).toBeInTheDocument();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
    expect(within(t.preview()).queryByText('Loading')).toBeNull();
    expect(panelOf('Request rate')).toHaveTextContent('Something went wrong');
    expect(t.calls((p) => p.vis.kind === 'stat' && p.id === 'p-1')).toHaveLength(1);
    const n = t.spy.mock.calls.length;
    await t.vis('Line');
    expect(t.spy.mock.calls.length).toBe(n);
    t.chartOnly();
    const f = t.previewFrame();
    expect(t.resizes(f)).toEqual([[760, 240, 1]]);
    expect(f.last('setData')?.[0]).toEqual(t.firstCallData('line'));
    expect(t.pendingShown()).toBe(true);
    act(() => {
      f.draw();
    });
    expect(within(t.preview()).queryByText('Loading')).toBeNull();
  });

  it('visualisation: Logs, then a cached chart', async () => {
    const t = await setup();
    await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    await t.vis('Logs');
    expect(await within(t.preview()).findByText(LOGS)).toBeInTheDocument();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
    const n = t.spy.mock.calls.length;
    await t.vis('Line');
    expect(t.spy.mock.calls.length).toBe(n);
    t.chartOnly();
    const f = t.previewFrame();
    expect(t.resizes(f)).toEqual([[760, 240, 1]]);
    expect(f.last('setData')?.[0]).toEqual(t.firstCallData('line'));
    expect(t.pendingShown()).toBe(true);
    act(() => {
      f.draw();
    });
    expect(within(t.preview()).queryByText('Loading')).toBeNull();
  });

  it('query: request at once, Loading, then the result', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    const before = t.previewFrame().last('setData')?.[0];
    const held = t.gated();
    act(() => {
      fireEvent.change(within(d).getByRole('textbox', { name: 'Query' }), {
        target: { value: 'sum(rate(x[5m]))' },
      });
    });
    expect(held).toHaveLength(1);
    expect(held[0]?.panel.query.text).toBe('sum(rate(x[5m]))');
    expect(held[0]?.panel.vis.kind).toBe('line');
    expect(within(t.preview()).getByText('Loading')).toBeInTheDocument();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
    await settle(() => {
      held[0]?.resolve();
    });
    const h0 = held[0];
    if (h0 === undefined) throw new Error('no call');
    const want = frameDataOf(stubPanelData(h0.panel, h0.window));
    await waitFor(() => {
      expect(t.previewFrame().last('setData')?.[0]).toEqual(want);
    });
    expect(want).not.toEqual(before);
  });

  it('query: a failed load shows the error state', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    const held = t.gated();
    act(() => {
      fireEvent.change(within(d).getByRole('textbox', { name: 'Query' }), {
        target: { value: 'sum(rate(x[5m]))' },
      });
    });
    await settle(() => {
      held[0]?.reject(new ApiError('network', 'x'));
    });
    expect(await within(t.preview()).findByText('Something went wrong')).toBeInTheDocument();
    expect(within(t.preview()).queryByText('Loading')).toBeNull();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
  });

  it('language: request at once, Loading, then the result', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    await t.vis('Auto');
    await t.waitKind('line');
    const held = t.gated();
    await t.user.click(within(d).getByRole('button', { name: /Query language$/ }));
    await t.user.click(await screen.findByRole('option', { name: 'LogQL' }));
    expect(held).toHaveLength(1);
    expect(held[0]?.panel.query.lang).toBe('logql');
    expect(held[0]?.panel.vis.kind).toBe('auto');
    expect(within(t.preview()).getByText('Loading')).toBeInTheDocument();
    await settle(() => {
      held[0]?.resolve();
    });
    await waitFor(() => {
      expect(t.previewFrame().last('setSpec')?.[0]).toMatchObject({ kind: 'bars' });
    });
  });

  it('successive changes: the last wins', async () => {
    const t = await setup();
    const d = await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    const held = t.gated();
    const since = t.mark();
    await t.vis('Bars');
    await t.vis('Heatmap');
    // (a) Two visualisations: the first is aborted and its late result never shows.
    expect(held.map((h) => h.panel.vis.kind)).toEqual(['bars', 'heatmap']);
    expect(held[0]?.signal?.aborted).toBe(true);
    await settle(() => {
      held[0]?.resolve();
    });
    expect(within(t.preview()).getByText('Loading')).toBeInTheDocument();
    expect(t.drawnKinds(since)).not.toContain('bars');
    await settle(() => {
      held[1]?.resolve();
    });
    await waitFor(() => {
      expect(t.previewFrame().last('setSpec')?.[0]).toMatchObject({ kind: 'heatmap' });
    });
    expect(t.drawnKinds(since)).not.toContain('bars');
    // (b) Two keystrokes in Query: the later result wins whatever order they arrive in.
    const query = within(d).getByRole('textbox', { name: 'Query' });
    await t.user.click(query);
    await t.user.keyboard('{End}1');
    await t.user.keyboard('2');
    expect(held).toHaveLength(4);
    const [h2, h3] = [held[2], held[3]];
    if (h2 === undefined || h3 === undefined) throw new Error('missing calls');
    expect(h2.panel.query.text).toMatch(/\)1$/);
    expect(h3.panel.query.text).toMatch(/\)12$/);
    const want = frameDataOf(stubPanelData(h3.panel, h3.window));
    const stale = frameDataOf(stubPanelData(h2.panel, h2.window));
    await settle(() => {
      h3.resolve();
    });
    await waitFor(() => {
      expect(t.previewFrame().last('setData')?.[0]).toEqual(want);
    });
    await settle(() => {
      h2.resolve();
    });
    expect(t.previewFrame().last('setData')?.[0]).toEqual(want);
    for (const f of t.engine.frames) {
      if (!t.preview().contains(f.canvas) && f.disposed === 0) continue;
      for (const c of f.calls.filter((x) => x.method === 'setData')) {
        expect(c.args[0]).not.toEqual(stale);
      }
    }
  });

  it("preview shares the panel's query and chart", async () => {
    const t = await setup({ edit: false });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-chart-frame]')).toHaveLength(3);
    });
    const n = t.spy.mock.calls.length;
    await t.openOn('Request rate');
    await waitFor(() => {
      expect(t.preview().querySelector('canvas')?.getAttribute('aria-label')).toMatch(
        /^Request rate/,
      );
    });
    expect(t.spy.mock.calls.length).toBe(n);
  });

  it.each(['board panel', 'full screen', 'preview'] as const)(
    'Loading until drawn: %s',
    async (where) => {
      const t = await setup();
      let host: HTMLElement;
      if (where === 'board panel') {
        host = await waitFor(() => {
          const el = panelOf('Request rate').querySelector<HTMLElement>('[data-chart-frame]');
          if (el === null) throw new Error('no chart');
          return el;
        });
      } else if (where === 'full screen') {
        await t.user.click(screen.getByRole('button', { name: 'Full screen: Request rate' }));
        const d = await screen.findByRole('dialog', { name: 'Request rate' });
        host = await waitFor(() => {
          const el = d.querySelector<HTMLElement>('[data-chart-frame]');
          if (el === null) throw new Error('no chart');
          return el;
        });
      } else {
        await t.openOn('Request rate');
        host = await waitFor(() => t.chartHost());
      }
      const f = t.engine.frames.findLast((x) => x.disposed === 0 && host.contains(x.canvas));
      if (f === undefined) throw new Error('no frame');
      const shown = (): boolean => host.querySelector('[data-chart-pending]') !== null;
      expect(host.querySelector('[data-chart-pending]')).toHaveTextContent('Loading');
      const step = (fn: () => void): void => {
        act(fn);
      };
      step(() => {
        resizeOf(host, 400, 200);
      });
      expect(shown()).toBe(true);
      step(() => {
        f.emit('drawn', { cssWidth: 100, cssHeight: 100, dpr: 1 });
      });
      expect(shown()).toBe(true);
      step(() => {
        f.draw();
      });
      expect(shown()).toBe(false);
      step(() => {
        resizeOf(host, 500, 200);
      });
      expect(shown()).toBe(true);
      step(() => {
        f.draw();
      });
      expect(shown()).toBe(false);
      step(() => {
        resizeOf(host, 0, 0);
      });
      expect(shown()).toBe(true);
      step(() => {
        f.draw();
      });
      expect(shown()).toBe(true);
    },
  );

  // Appendix C §C.2: the preview host's size stays current while a message shows.

  it('fresh dialog on Logs: a cached chart is pre-sized', async () => {
    const t = await setup();
    let d = await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    await t.vis('Logs');
    expect(await within(t.preview()).findByText(LOGS)).toBeInTheDocument();
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    d = await t.openOn('Request rate');
    expect(await within(t.preview()).findByText(LOGS)).toBeInTheDocument();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
    act(() => {
      resizeOf(t.previewHost(), 640, 240);
    });
    const n = t.spy.mock.calls.length;
    await t.vis('Line');
    expect(t.spy.mock.calls.length).toBe(n);
    const f = t.previewFrame();
    expect(t.resizes(f)[0]).toEqual([640, 240, 1]);
    expect(t.pendingShown()).toBe(true);
    act(() => {
      f.draw();
    });
    expect(t.pendingShown()).toBe(false);
    expect(d).toBeInTheDocument();
  });

  it('fresh dialog on an error: a cached chart is pre-sized', async () => {
    const t = await setup();
    let d = await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    const held = t.gated();
    await t.vis('Stat');
    await settle(() => {
      held[0]?.reject(new ApiError('network', 'x'));
    });
    expect(await within(t.preview()).findByText('Something went wrong')).toBeInTheDocument();
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    d = await t.openOn('Request rate');
    // The failed key refetches when the preview mounts on it: fail that call too.
    await waitFor(() => {
      expect(held.length).toBeGreaterThan(1);
    });
    await settle(() => {
      for (const h of held.slice(1)) h.reject(new ApiError('network', 'x'));
    });
    expect(await within(t.preview()).findByText('Something went wrong')).toBeInTheDocument();
    expect(t.preview().querySelector('[data-chart-frame]')).toBeNull();
    act(() => {
      resizeOf(t.previewHost(), 640, 240);
    });
    const n = t.spy.mock.calls.length;
    await t.vis('Line');
    expect(t.spy.mock.calls.length).toBe(n);
    const f = t.previewFrame();
    expect(t.resizes(f)[0]).toEqual([640, 240, 1]);
    expect(t.pendingShown()).toBe(true);
    act(() => {
      f.draw();
    });
    expect(t.pendingShown()).toBe(false);
    expect(d).toBeInTheDocument();
  });

  it('resize while a message shows', async () => {
    const t = await setup();
    await t.openOn('Request rate');
    await waitFor(() => t.previewFrame());
    t.showPreview();
    await t.vis('Logs');
    expect(await within(t.preview()).findByText(LOGS)).toBeInTheDocument();
    act(() => {
      resizeOf(t.previewHost(), 600, 200);
    });
    await t.vis('Line');
    const f = t.previewFrame();
    expect(t.resizes(f)[0]).toEqual([600, 200, 1]);
    expect(t.pendingShown()).toBe(true);
    act(() => {
      f.draw();
    });
    expect(t.pendingShown()).toBe(false);
  });
});
