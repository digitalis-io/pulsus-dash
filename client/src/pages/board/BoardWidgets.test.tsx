/**
 * Widget panels on a board (plan #198 Part 1 §4.2, `unit:widget-frame`; T24-002, VIZ-053): a
 * widget has a frame, a title and the layout tools, no query, chart, Explore or Full screen, and
 * shows "not available yet" until its kind is drawn. Part 3a (§5): Text panels draw, Add widget
 * and Edit panel go through the registry (`unit:widget-registry-generic`), and an edit keeps the
 * stored representation of every other key (`unit:widget-spec-roundtrip`,
 * `unit:text-vis-roundtrip`).
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type BoardSpec } from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { canonicalJson, checkBoardSpec } from '../../boards/spec';
import { findS } from '../../widgets/boardList/fixtures';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { messages } from '../../i18n/messages.en-GB';
import { StubApi } from '../../api/StubApi';
import type { MessageId } from '../../i18n/t';
import { Checkbox } from '../../kit/Checkbox';
import {
  type Board,
  calls,
  closeMenu,
  flush,
  openBoard,
  openMenu,
  ready,
  reqs,
  show,
} from '../../test/boardPanelKit';
import { boardWith, EngineWrapper, panel, panelOf, stubBoard } from '../../test/boardTestKit';
import { renderApp } from '../../test/renderApp';
import { clockOptions } from '../../widgets/spec';
import {
  TEXT_DEF,
  WidgetRegistryContext,
  type WidgetDef,
  type WidgetEditorBodyProps,
  type WidgetRegistry,
} from '../../widgets/registry';
import { fakeEditorSource } from '../../test/fakeEditor';
import { installIntersectionObserver } from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { seedWith } from '../../test/seeds';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

// The test-only kind's label and title (unit:widget-registry-generic).
vi.mock('../../i18n/messages.en-GB', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../i18n/messages.en-GB')>();
  return {
    ...m,
    messages: { ...m.messages, 'test.probe': 'Probe', 'test.probeEdit': 'Edit probe' },
  };
});

const FIXTURES = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec');

function spec(name: string): BoardSpec {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as BoardSpec;
}

function widgets(): BoardSpec {
  return spec('v5-widgets.json');
}

const WIDGETS = ['Runbook', 'Request rate query', 'Notes', 'Clocks', 'Local time'];
const TEXTS = ['Runbook', 'Request rate query', 'Notes'];
const ALL = [...WIDGETS, 'Requests'];

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

function open() {
  return openBoard([], { seed: seedWith({ boards: [stubBoard('b-1', widgets())] }) });
}

/** The item names of `title`'s Panel menu; the menu is closed again. */
async function menuOf(t: Board, title: string): Promise<string[]> {
  await openMenu(t, title);
  const menu = screen.getByRole('menu', { name: `Panel menu: ${title}` });
  const items = within(menu)
    .getAllByRole('menuitem')
    .map((m) => m.textContent);
  await closeMenu(t);
  return items;
}

describe('unit:widget-frame', () => {
  it('Text panels draw; other widgets show not available; no query, chart, Explore or Full screen', async () => {
    const t = open();
    await ready(...ALL);
    show(...ALL);
    await calls(t, 1);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(1);
    expect(reqs(t)[0]?.query).toBe('sum(rate(http_requests_total[5m]))');
    expect(document.querySelectorAll('[data-widget]')).toHaveLength(5);
    for (const title of WIDGETS) {
      const p = panelOf(title);
      expect(p, title).toHaveAttribute('data-widget');
      expect(p, title).toHaveAttribute('data-panel-state', 'widget');
      expect(within(p).queryByRole('link', { name: `Open in Explore: ${title}` })).toBeNull();
      expect(within(p).queryByRole('button', { name: `Open in Explore: ${title}` })).toBeNull();
      expect(within(p).queryByRole('button', { name: `Full screen: ${title}` })).toBeNull();
      expect(p.querySelector('[data-chart-frame]'), title).toBeNull();
    }
    for (const title of TEXTS) {
      await waitFor(() => {
        expect(within(panelOf(title)).getByRole('region', { name: title })).toBeInTheDocument();
      });
      expect(within(panelOf(title)).queryByText(messages['widget.kindUnavailable'])).toBeNull();
    }
    expect(
      await within(panelOf('Runbook')).findByRole('heading', { level: 4, name: 'Runbook' }),
    ).toBeInTheDocument();
    expect(within(panelOf('Notes')).getByText(messages['widget.text.empty'])).toBeInTheDocument();
    for (const title of ['Clocks', 'Local time']) {
      expect(
        within(panelOf(title)).getByText(messages['widget.kindUnavailable']),
      ).toBeInTheDocument();
    }
    expect(panelOf('Requests')).not.toHaveAttribute('data-widget');
    expect(await menuOf(t, 'Runbook')).toEqual(['Edit panel', 'Duplicate', 'Remove']);
    expect(await menuOf(t, 'Clocks')).toEqual(['Duplicate', 'Remove']);
  });

  it('the section header adds a Text into its section; the board saves valid', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready(...ALL);
    await t.user.click(screen.getByRole('button', { name: 'Edit board' }));
    await t.user.click(await screen.findByRole('button', { name: 'Add widget to Time' }));
    await t.user.click(await screen.findByRole('menuitem', { name: 'Text' }));
    const d = await screen.findByRole('dialog', { name: 'Edit text panel' });
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const spec = save.mock.calls[0]?.[3];
    if (spec === undefined) throw new Error('no saved spec');
    expect(spec.sections[0]?.panels[1]).toEqual({
      id: 'p-7',
      title: '',
      grid: { x: 4, y: 0, w: 6, h: 6 },
      vis: { kind: 'text', options: { mode: 'markdown', content: '' } },
    });
    expect(checkBoardSpec(spec)).toEqual([]);
  });

  it('a selected Text opens the widget editor, not the panel editor', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard').mockRejectedValue(
      new ApiError('invalid', 'invalid board', {
        fields: [{ pointer: '/panels/0/title', messageKey: 'board.panel.title.tooLong' }],
      }),
    );
    await ready(...ALL);
    // A change to save: Duplicate enters Edit mode.
    await openMenu(t, 'Notes');
    await t.user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByRole('heading', { level: 3, name: 'Notes (copy)' });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(panelOf('Runbook')).toHaveAttribute('data-selected');
    });
    const d = await screen.findByRole('dialog', { name: 'Edit text panel' });
    expect(within(d).getByRole('textbox', { name: 'Title' })).toHaveAccessibleDescription(
      fieldMessage('board.panel.title.tooLong'),
    );
    expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
  });

  it('a duplicated widget saves without a query', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready(...ALL);
    await openMenu(t, 'Runbook');
    await t.user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByRole('heading', { level: 3, name: 'Runbook (copy)' });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const spec = save.mock.calls[0]?.[3];
    if (spec === undefined) throw new Error('no saved spec');
    const copy = spec.panels.find((p) => p.title === 'Runbook (copy)');
    expect(copy).toBeDefined();
    expect(copy !== undefined && 'query' in copy).toBe(false);
    expect(copy?.vis).toEqual(widgets().panels[0]?.vis);
    expect(checkBoardSpec(spec)).toEqual([]);
  });
});

/** Opens Edit panel on `title` and returns the widget editor. */
async function editText(t: Board, title: string): Promise<HTMLElement> {
  await openMenu(t, title);
  await t.user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
  return screen.findByRole('dialog', { name: 'Edit text panel' });
}

function contentOf(d: HTMLElement): HTMLElement {
  return within(d).getByRole('textbox', { name: 'Content' });
}

async function done(t: Board, d: HTMLElement): Promise<void> {
  await t.user.click(within(d).getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
}

/** The toolbar's Save: behind an open editor too (the board is `aria-hidden` then). */
const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Save', hidden: true });

describe('unit:widget-spec-roundtrip', () => {
  it('a content edit changes only that key; typing it back, Discard and Save keep the rest', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready(...ALL);
    const fixture = widgets();
    const original = fixture.panels[0]?.vis.options?.content ?? '';

    // Edit, then type the original back: the draft is clean again (no Undo, SRF-020).
    let d = await editText(t, 'Runbook');
    await t.user.type(contentOf(d), '!');
    await waitFor(() => {
      expect(saveButton()).toBeEnabled();
    });
    await t.user.type(contentOf(d), '{Backspace}');
    expect(contentOf(d)).toHaveValue(original);
    await done(t, d);
    expect(saveButton()).toBeDisabled();

    // Edit again and Discard: the head again.
    d = await editText(t, 'Runbook');
    await t.user.type(contentOf(d), '!');
    await done(t, d);
    expect(saveButton()).toBeEnabled();
    await t.user.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByRole('button', { name: 'Edit board' });
    await t.user.click(screen.getByRole('button', { name: 'Edit board' }));
    expect(saveButton()).toBeDisabled();

    // Edit again and Save: only that key changes; every other panel is byte-equal.
    d = await editText(t, 'Runbook');
    await t.user.type(contentOf(d), '!');
    await done(t, d);
    await t.user.click(saveButton());
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const sent = save.mock.calls[0]?.[3];
    if (sent === undefined) throw new Error('no saved spec');
    const want = structuredClone(fixture);
    const opts = want.panels[0]?.vis.options;
    if (opts === undefined) throw new Error('fixture p-1 has no options');
    opts.content = `${original}!`;
    expect(sent).toEqual(want);
    fixture.panels.slice(1).forEach((p, i) => {
      expect(canonicalJson(sent.panels[i + 1]), p.id).toBe(canonicalJson(p));
    });
    expect(canonicalJson(sent.sections)).toBe(canonicalJson(fixture.sections));

    // A refetch shows the saved spec.
    await t.queryClient.invalidateQueries({ queryKey: ['board'] });
    await flush();
    const shown = await t.api.getBoard('demo', 'b-1');
    expect(shown.spec).toEqual(want);
    await waitFor(() => {
      expect(panelOf('Runbook').querySelector('[data-text-measure]')?.textContent).toMatch(/\.!$/);
    });
  });
});

describe('unit:text-vis-roundtrip (board)', () => {
  it('a panel without options stays without options when its edit is undone', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready(...ALL);
    let d = await editText(t, 'Notes');
    await t.user.type(contentOf(d), 'abc');
    await waitFor(() => {
      expect(saveButton()).toBeEnabled();
    });
    await t.user.type(contentOf(d), '{Backspace}{Backspace}{Backspace}');
    await done(t, d);
    expect(saveButton()).toBeDisabled();

    d = await editText(t, 'Runbook');
    await t.user.type(within(d).getByRole('textbox', { name: 'Title' }), 's');
    await done(t, d);
    await t.user.click(saveButton());
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const sent = save.mock.calls[0]?.[3];
    expect(canonicalJson(sent?.panels[2])).toBe(canonicalJson(widgets().panels[2]));
    expect(sent?.panels[0]?.title).toBe('Runbooks');
  });
});

describe('unit:widget-registry-generic', () => {
  const PROBE_DEF: WidgetDef = {
    kind: 'clock',
    label: 'test.probe' as MessageId,
    editTitle: 'test.probeEdit' as MessageId,
    size: { w: 4, h: 3 },
    newVis: () => ({ kind: 'clock', options: { date: true } }),
    Editor: function ProbeEditor({ panel, onVis }: WidgetEditorBodyProps) {
      return (
        <Checkbox
          isSelected={clockOptions(panel.vis.options).date}
          onChange={(date) => {
            onVis({ ...panel.vis, options: { ...panel.vis.options, date } });
          }}
        >
          Date
        </Checkbox>
      );
    },
  };
  const REGISTRY: WidgetRegistry = { defs: [TEXT_DEF, PROBE_DEF] };

  it('a test kind is added, edited and saved through the same path', async () => {
    const api = new StubApi(seedWith({ boards: [stubBoard('b-1', widgets())] }));
    const save = vi.spyOn(api, 'saveBoard');
    const t = renderApp('/t/demo/board/b-1', {
      rangeStore: 'off',
      api,
      wrapper: ({ children }) => (
        <EngineWrapper>
          <WidgetRegistryContext.Provider value={REGISTRY}>
            {children}
          </WidgetRegistryContext.Provider>
        </EngineWrapper>
      ),
    });
    await ready(...ALL);
    await t.user.click(screen.getByRole('button', { name: 'Edit board' }));
    await t.user.click(screen.getByRole('button', { name: 'Add widget' }));
    const menu = await screen.findByRole('menu', { name: 'Add widget' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Text', 'Probe']);
    await t.user.click(within(menu).getByRole('menuitem', { name: 'Probe' }));
    const d = await screen.findByRole('dialog', { name: 'Edit probe' });
    await t.user.click(within(d).getByRole('checkbox', { name: 'Date' }));
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const spec = save.mock.calls[0]?.[3];
    expect(spec?.panels[5]).toEqual({
      id: 'p-7',
      title: '',
      grid: { x: 0, y: 24, w: 4, h: 3 },
      vis: { kind: 'clock', options: { date: false } },
    });
    await t.user.click(screen.getByRole('button', { name: 'Panel menu: Clocks' }));
    const items = within(await screen.findByRole('menu', { name: 'Panel menu: Clocks' }))
      .getAllByRole('menuitem')
      .map((m) => m.textContent);
    expect(items).toEqual(['Edit panel', 'Duplicate', 'Remove']);
  });
});

// Plan #216 Part 2a §5 (`unit:widget-frame` amended): stored board lists draw; Clock is still
// pending (above); a Board list's menu has Edit panel (Part 2b) and Show as table.
describe('unit:widget-frame (board lists)', () => {
  it('stored board lists draw; only the data panel runs; the menu', async () => {
    const lists = ['Starred', 'Recent', 'Checkout boards', 'Payments team', 'Search'];
    const t = openBoard([], {
      seed: seedWith({ boards: [stubBoard('b-1', spec('v6-board-list.json'))] }),
    });
    await ready(...lists, 'Requests');
    show(...lists, 'Requests');
    await calls(t, 1);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(1);
    expect(reqs(t)[0]?.query).toBe('sum(rate(http_requests_total[5m]))');
    for (const title of lists) {
      const p = panelOf(title);
      expect(p, title).toHaveAttribute('data-widget');
      await waitFor(() => {
        expect(p.querySelector('[data-board-list]'), title).not.toBeNull();
      });
      expect(within(p).queryByText(messages['widget.kindUnavailable'])).toBeNull();
      expect(p.querySelector('[data-chart-frame]'), title).toBeNull();
    }
    expect(panelOf('Requests')).not.toHaveAttribute('data-widget');
    expect(await menuOf(t, 'Starred')).toEqual([
      'Edit panel',
      'Show as table',
      'Duplicate',
      'Remove',
    ]);
  });
});

// Plan #216 Part 2b §5: Add widget → Board list and its editor on the board.

/** A board whose only panel is the search list "Find" (query `query`). */
function openFind(query = '') {
  const lists: BoardSpec = {
    title: 'Lists',
    panels: [
      {
        id: 'p-1',
        title: 'Find',
        grid: { x: 0, y: 0, w: 6, h: 8 },
        vis: { kind: 'boardList', options: { mode: 'search', query } },
      },
    ],
    sections: [],
  };
  const t = openBoard([], { seed: seedWith({ boards: [stubBoard('b-1', lists)] }) });
  vi.spyOn(t.api, 'listBoards').mockImplementation((_t, _s, f) => Promise.resolve(findS(f ?? {})));
  return t;
}

async function editList(t: Board, title: string): Promise<HTMLElement> {
  await openMenu(t, title);
  await t.user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
  return screen.findByRole('dialog', { name: 'Edit board list' });
}

/** Sets an input's value as one change (a paste). */
function setValue(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

const modS = (t: Board) => t.user.keyboard('{Control>}s{/Control}');
const saveStatus = (d: HTMLElement): HTMLElement =>
  within(d).getByRole('status', { name: 'Save status' });
const pageStatus = (): HTMLElement | undefined =>
  screen
    .getAllByRole('status', { name: 'Save status', hidden: true })
    .find((el) => el.closest('[role=dialog]') === null);
const savedOptions = (save: { mock: { calls: unknown[][] } }, n: number) =>
  (save.mock.calls[n]?.[3] as BoardSpec | undefined)?.panels[0]?.vis.options;

describe('unit:board-list-preview (board)', () => {
  it('the preview is inert and link-free; the board keeps its Esc step after the editor', async () => {
    const t = openFind('check');
    await ready('Find');
    await waitFor(() => {
      expect(within(panelOf('Find')).getAllByRole('link')).toHaveLength(2);
    });
    const d = await editList(t, 'Find');
    const preview = within(d).getByRole('group', { name: 'Preview' });
    expect(preview.querySelector('[inert]')).not.toBeNull();
    await waitFor(() => {
      expect(within(preview).getAllByRole('listitem')).toHaveLength(2);
    });
    expect(within(preview).queryAllByRole('link')).toHaveLength(0);
    expect(within(preview).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(preview).queryAllByRole('button')).toHaveLength(0);
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const field = within(panelOf('Find')).getByRole('textbox', { name: 'Search boards' });
    await t.user.clear(field);
    await t.user.type(field, 'x');
    expect(field).toHaveValue('x');
    await t.user.keyboard('{Escape}');
    expect(field).toHaveValue('');
  });
});

describe('unit:board-list-editor-invalid', () => {
  it('an invalid Search text or Rows blocks Done and Save until fixed; Esc drops it', async () => {
    const t = openFind();
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready('Find');
    let d = await editList(t, 'Find');
    const text = () => within(d).getByRole('textbox', { name: 'Search text' });
    const rows = () => within(d).getByRole('textbox', { name: 'Rows' });
    const done = () => within(d).getByRole('button', { name: 'Done' });
    const behind = () =>
      within(panelOf('Find')).getByRole('textbox', { name: 'Search boards', hidden: true });

    setValue(text(), 'a');
    await waitFor(() => {
      expect(behind()).toHaveValue('a');
    });
    setValue(text(), 'a\tb');
    expect(text()).toHaveValue('a\tb');
    expect(text()).toHaveAccessibleDescription(/Search text cannot contain control characters/);
    expect(done()).toBeDisabled();
    expect(saveStatus(d)).toHaveTextContent('Search text cannot contain control characters');
    expect(behind()).toHaveValue('a');
    await modS(t);
    await waitFor(() => {
      expect(pageStatus()).toHaveTextContent('Fix the highlighted field in the panel editor first');
    });
    expect(save).not.toHaveBeenCalled();

    setValue(text(), 'ab');
    setValue(rows(), '0');
    expect(rows()).toHaveAccessibleDescription(/Use a whole number from 1 to 50\./);
    expect(done()).toBeDisabled();
    await modS(t);
    expect(save).not.toHaveBeenCalled();

    setValue(rows(), '5');
    expect(done()).toBeEnabled();
    await t.user.click(done());
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Esc with an invalid Rows: the dialog closes, the draft keeps 5, Save goes ahead.
    d = await editList(t, 'Find');
    setValue(rows(), '0');
    expect(done()).toBeDisabled();
    await t.user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(savedOptions(save, 0)).toEqual({ mode: 'search', query: 'ab', limit: 5 });
  });
});

describe('unit:board-list-editor-length', () => {
  it('Search text counts code points: 100 emoji save, 101 block', async () => {
    const t = openFind();
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready('Find');
    const d = await editList(t, 'Find');
    const text = () => within(d).getByRole('textbox', { name: 'Search text' });
    const done = () => within(d).getByRole('button', { name: 'Done' });
    const hundred = '\u{1F600}'.repeat(100);
    setValue(text(), hundred);
    expect(text()).toHaveValue(hundred);
    expect(text()).not.toHaveAccessibleDescription(/Use up to 100 characters/);
    expect(done()).toBeEnabled();
    await modS(t);
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(savedOptions(save, 0)).toEqual({ mode: 'search', query: hundred });

    setValue(text(), `${hundred}\u{1F600}`);
    expect(text()).toHaveAccessibleDescription(
      /Use up to 100 characters without control characters, in search mode only\./,
    );
    expect(done()).toBeDisabled();
    await modS(t);
    await waitFor(() => {
      expect(pageStatus()).toHaveTextContent('Fix the highlighted field in the panel editor first');
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('unit:widget-registry (Board list)', () => {
  it('Add widget → Board list adds a 4 × 8 list, opens its editor and saves valid', async () => {
    const t = openBoard([], { seed: boardWith([panel('p-1', 'Requests', 'up')]) });
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready('Requests');
    await t.user.click(screen.getByRole('button', { name: 'Edit board' }));
    await t.user.click(screen.getByRole('button', { name: 'Add widget' }));
    const menu = await screen.findByRole('menu', { name: 'Add widget' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Text', 'Board list']);
    await t.user.click(within(menu).getByRole('menuitem', { name: 'Board list' }));
    const d = await screen.findByRole('dialog', { name: 'Edit board list' });
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const spec = save.mock.calls[0]?.[3];
    if (spec === undefined) throw new Error('no saved spec');
    expect(spec.panels[1]).toEqual({
      id: 'p-2',
      title: '',
      grid: { x: 6, y: 0, w: 4, h: 8 },
      vis: { kind: 'boardList' },
    });
    expect(checkBoardSpec(spec)).toEqual([]);
    expect(await menuOf(t, 'Untitled panel')).toEqual([
      'Edit panel',
      'Show as table',
      'Duplicate',
      'Remove',
    ]);
  });
});
