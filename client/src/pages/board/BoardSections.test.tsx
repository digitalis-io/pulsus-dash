/** Collapsible sections (plan #61 Part C §4.2, Appendix C-A §A.7). */
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi, type StubBoard } from '../../api/StubApi';
import { defaultSeed } from '../../api/stubData';
import type {
  BoardSpec,
  DataPanelSpec,
  RangeRequest,
  SaveResult,
  SectionSpec,
} from '../../api/types';
import { isDataPanel } from '../../widgets/spec';
import { deferred, EngineWrapper, panelTitles, stubBoard } from '../../test/boardTestKit';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { renderApp, type RenderAppOptions } from '../../test/renderApp';
import { seedWith } from '../../test/seeds';

beforeEach(() => {
  installResizeObserver();
});

function open(url: string, o: RenderAppOptions = {}) {
  return renderApp(url, { wrapper: EngineWrapper, ...o });
}

function p(id: string, title: string, [x, y, w, h]: readonly number[]): DataPanelSpec {
  return {
    id,
    title,
    grid: { x: x ?? 0, y: y ?? 0, w: w ?? 1, h: h ?? 1 },
    query: { lang: 'promql', text: `up{panel="${id}"}` },
    vis: { kind: 'line' },
  };
}

/** The default seed with b-1's section `s-1` replaced. */
function withSection(section: SectionSpec): StubBoard[] {
  return defaultSeed.boards.map((b) =>
    b.uid === 'b-1' ? { ...b, spec: { ...b.spec, sections: [section] } } : b,
  );
}

const COLLAPSED: SectionSpec = {
  id: 's-1',
  title: 'Latency',
  collapsed: true,
  panels: [p('p-4', 'Request latency', [0, 0, 6, 8]), p('p-5', 'Latency p99', [6, 0, 6, 8])],
};

/** Each seeded panel's id by its query text (every seeded panel has its own). */
const BY_TEXT = new Map(
  [
    ...defaultSeed.boards.flatMap((b) => [
      ...b.spec.panels,
      ...b.spec.sections.flatMap((x) => x.panels),
    ]),
    ...COLLAPSED.panels,
  ]
    .filter(isDataPanel)
    .map((x) => [x.query.text, x.id]),
);

/** The ids `queryRange` was called for, in call order, without repeats (plan #64 A.5). */
function queried(spy: { mock: { calls: unknown[][] } }): string[] {
  return [...new Set(spy.mock.calls.map((c) => BY_TEXT.get((c[1] as RangeRequest).query) ?? '?'))];
}

/** Every panel body gets a width, so the panels can run (plan #64 §4.1). */
function sizePanels(): void {
  act(() => {
    resizeAll(1000, 240);
  });
}

function sectionOf(title: string): HTMLElement {
  const b = screen.getByRole('button', { name: title });
  const s = b.closest<HTMLElement>('[data-section]');
  if (s === null) throw new Error(`no section ${title}`);
  return s;
}

async function editMode(user: ReturnType<typeof open>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Edit board' }));
  await screen.findByRole('button', { name: 'Save' });
}

function statusLine(): HTMLElement {
  return screen.getByRole('status', { name: 'Save status' });
}

describe('sections', () => {
  it('collapsed sections do not query', async () => {
    const api = new StubApi(seedWith({ boards: withSection(COLLAPSED) }));
    const data = vi.spyOn(api, 'queryRange');
    const { user } = open('/t/demo/board/b-1', { api });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    sizePanels();
    await waitFor(() => {
      expect(queried(data)).toEqual(['p-1', 'p-2']);
    });
    const toggle = screen.getByRole('button', { name: 'Latency' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(sectionOf('Latency')).getByText('2 panels')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Request latency' })).toBeNull();
    expect(queried(data)).toEqual(['p-1', 'p-2']);

    await user.click(toggle);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
    sizePanels();
    await waitFor(() => {
      expect(queried(data)).toEqual(['p-1', 'p-2', 'p-4', 'p-5']);
    });
    expect(screen.getByRole('heading', { level: 3, name: 'Request latency' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: 'Latency p99' })).toBeVisible();
  });

  it('view toggles go to the URL', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user, router } = open('/t/demo/board/b-1', { api });
    const toggle = await screen.findByRole('button', { name: 'Latency' });
    const before = window.history.length;
    await user.click(toggle);
    await waitFor(() => {
      expect(router.state.location.search).toContain('collapse=s-1');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(window.history.length).toBe(before);
    expect(save).not.toHaveBeenCalled();
    expect((await api.getBoard('demo', 'b-1')).spec.sections[0]?.collapsed).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Latency' }));
    await waitFor(() => {
      expect(router.state.location.search).not.toMatch(/collapse=|expand=/);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Latency' }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('collapse=s-1');
    });
    await editMode(user);
    await waitFor(() => {
      expect(router.state.location.search).not.toContain('collapse');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('fresh session: collapsed override', async () => {
    const api = new StubApi();
    const data = vi.spyOn(api, 'queryRange');
    open('/t/demo/board/b-1?from=now-1h&to=now&refresh=off&collapse=s-1', { api });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    sizePanels();
    const toggle = screen.getByRole('button', { name: 'Latency' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(sectionOf('Latency')).getByText('1 panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(queried(data)).toEqual(['p-1', 'p-2']);
    });
    expect(queried(data)).not.toContain('p-4');
  });

  it('fresh session: expanded override', async () => {
    const seed = seedWith({ boards: withSection(COLLAPSED) });
    const api = new StubApi(seed);
    const data = vi.spyOn(api, 'queryRange');
    const one = open('/t/demo/board/b-1?from=now-1h&to=now&refresh=off&expand=s-1', { api });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
    sizePanels();
    await waitFor(() => {
      expect(queried(data)).toEqual(expect.arrayContaining(['p-4', 'p-5']));
    });
    one.view.unmount();

    const api2 = new StubApi(seed);
    const data2 = vi.spyOn(api2, 'queryRange');
    open('/t/demo/board/b-1?from=now-1h&to=now&refresh=off', { api: api2 });
    await screen.findByRole('heading', { level: 3, name: 'Request rate' });
    sizePanels();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
    await waitFor(() => {
      expect(queried(data2)).toEqual(['p-1', 'p-2']);
    });
  });

  it('edit toggles are saved', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Latency' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    expect(save.mock.calls[0]?.[3].sections[0]?.collapsed).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Edit board' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Latency' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  });

  it('add, rename and remove sections', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-2', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add section' }));
    expect(screen.getByRole('button', { name: 'Untitled section' })).toBeInTheDocument();
    const title = screen.getByRole('textbox', { name: 'Section 1 title' });
    await user.type(title, 'Errors');
    expect(screen.getByRole('button', { name: 'Errors' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add panel to Errors' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit panel' });
    await user.click(within(editor).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    const panel = within(sectionOf('Errors'))
      .getByRole('heading', { level: 3 })
      .closest('[data-panel]');
    expect(panel).toHaveAttribute('data-grid', '0,0,6,8');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    const spec: BoardSpec | undefined = save.mock.calls[0]?.[3];
    expect(spec?.sections).toEqual([
      {
        id: 's-1',
        title: 'Errors',
        collapsed: false,
        panels: [
          {
            id: 'p-1',
            title: '',
            grid: { x: 0, y: 0, w: 6, h: 8 },
            query: { lang: 'promql', text: '' },
            vis: { kind: 'auto' },
          },
        ],
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove section Errors' }));
    expect(screen.queryByRole('button', { name: 'Errors' })).toBeNull();
    expect(document.querySelectorAll('[data-section]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('section counts', async () => {
    const sec = (id: string, title: string, n: number): SectionSpec => ({
      id,
      title,
      collapsed: false,
      panels: Array.from({ length: n }, (_, i) =>
        p(`p-${id}-${String(i)}`, `${title} ${String(i)}`, [i * 4, 0, 4, 8]),
      ),
    });
    const spec: BoardSpec = {
      title: 'Counts',
      panels: [],
      sections: [sec('s-1', 'None', 0), sec('s-2', 'One', 1), sec('s-3', 'Three', 3)],
    };
    open('/t/demo/board/b-9', {
      api: new StubApi(seedWith({ boards: [stubBoard('b-9', spec)] })),
    });
    await screen.findByRole('button', { name: 'None' });
    expect(within(sectionOf('None')).getByText('No panels')).toBeInTheDocument();
    expect(within(sectionOf('One')).getByText('1 panel')).toBeInTheDocument();
    expect(within(sectionOf('Three')).getByText('3 panels')).toBeInTheDocument();
  });

  it('section title too long', async () => {
    const api = new StubApi();
    const save = vi.spyOn(api, 'saveBoard');
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    const title = screen.getByRole('textbox', { name: 'Section 1 title' });
    await user.clear(title);
    await user.click(title);
    await user.paste('a'.repeat(201));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Problems to fix before saving: 1');
    });
    expect(save).not.toHaveBeenCalled();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAccessibleDescription('Use at most 200 characters');
    // Nothing under the status line: the error shows under its field only.
    expect(screen.getAllByText('Use at most 200 characters')).toHaveLength(1);
  });

  it('section controls read-only while saving', async () => {
    const api = new StubApi();
    const pending = deferred<SaveResult>();
    let sent: BoardSpec | null = null;
    vi.spyOn(api, 'saveBoard').mockImplementation((_t, _u, _e, spec) => {
      sent = spec;
      return pending.promise;
    });
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add section' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const names = [
      'Add section',
      'Add panel to Latency',
      'Remove section Latency',
      'Latency',
      'Untitled section',
    ];
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saving');
    });
    for (const name of names) expect(screen.getByRole('button', { name }), name).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Section 1 title' })).toHaveAttribute('readonly');
    const head = await api.getBoard('demo', 'b-1');
    await act(async () => {
      const spec = sent ?? head.spec;
      pending.resolve({ board: { ...head, version: 2, etag: '2', spec }, changed: true });
      await pending.promise;
    });
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('Saved');
    });
    for (const name of names) expect(screen.getByRole('button', { name }), name).toBeEnabled();
  });

  it('sections full', async () => {
    const spec: BoardSpec = {
      title: 'Full',
      panels: [],
      sections: Array.from({ length: 50 }, (_, i) => ({
        id: `s-${String(i + 1)}`,
        title: `S${String(i + 1)}`,
        collapsed: false,
        panels: [],
      })),
    };
    const { user } = open('/t/demo/board/b-9', {
      api: new StubApi(seedWith({ boards: [stubBoard('b-9', spec)] })),
    });
    await editMode(user);
    await user.click(screen.getByRole('button', { name: 'Add section' }));
    const live = document.querySelector('[data-board-live]');
    expect(live).toHaveTextContent('A board can have at most 50 sections');
    expect(statusLine()).toHaveTextContent('A board can have at most 50 sections');
    expect(document.querySelectorAll('[data-section]')).toHaveLength(50);
    expect(panelTitles()).toEqual([]);
  });
});

describe('section panel queries (plan #64 §5.1)', () => {
  it('collapsed section panels do not query', async () => {
    const section: SectionSpec = {
      id: 's-1',
      title: 'Hidden',
      collapsed: true,
      panels: [{ ...p('p-2', 'Inside', [0, 0, 6, 8]), query: { lang: 'promql', text: 'inside' } }],
    };
    const seed = seedWith({
      boards: [
        stubBoard('b-1', {
          title: 'Board',
          panels: [{ ...p('p-1', 'Top', [0, 0, 6, 8]), query: { lang: 'promql', text: 'top' } }],
          sections: [section],
        }),
      ],
    });
    const api = new StubApi(seed);
    const range = vi.spyOn(api, 'queryRange');
    const { user } = open('/t/demo/board/b-1?from=now-1h&to=now&refresh=off', { api });
    await screen.findByRole('heading', { level: 3, name: 'Top' });
    act(() => {
      resizeAll(1000, 240);
    });
    const texts = () => range.mock.calls.map((c) => c[1].query);
    await waitFor(() => {
      expect(texts()).toEqual(['top']);
    });
    await user.click(screen.getByRole('button', { name: 'Hidden' }));
    await screen.findByRole('heading', { level: 3, name: 'Inside' });
    act(() => {
      resizeAll(1000, 240);
    });
    await waitFor(() => {
      expect(texts()).toEqual(['top', 'inside']);
    });
  });
});
