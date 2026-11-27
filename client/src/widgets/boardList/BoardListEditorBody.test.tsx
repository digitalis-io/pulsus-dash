/**
 * The Board list editor body (plan #216 Part 2b §4.1, §5), inside the widget editor over a draft
 * panel: `unit:board-list-editor` (each control's write, the debounced preview, the field errors,
 * read-only), the editor leg of `unit:board-spec-board-list` (control characters stay local) and
 * the body leg of `unit:board-list-preview` (the preview is inert and holds no control).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../../api/Api';
import type { VisOptions, WidgetPanelSpec } from '../../api/types';
import { ApiContext } from '../../app/providers';
import { WidgetEditor } from '../../pages/board/WidgetEditor';
import { createClock } from '../../state/clock';
import { TimeZoneContext } from '../../state/timeZone';
import { ClockContext } from '../../state/useTimeContext';
import { LIST_TIME, listPanel, tick } from '../../test/boardListKit';
import { installGridLayout } from '../../test/fakeLayout';
import { BOARD_LIST_DEF } from '../registry';
import { B, findS } from './fixtures';

let restore: () => void = () => undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-26T12:30:00Z') });
  restore = installGridLayout();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

/** An Api answering the list calls from B and S; `boards` records each `listBoards` filter. */
function listApi() {
  const boards: { q?: string; tag?: string }[] = [];
  const saveBoard = vi.fn();
  const api = {
    listStarred: () => Promise.resolve(B),
    listRecent: () => Promise.resolve(B),
    listBoards: (_t: string, _s?: AbortSignal, f: { q?: string; tag?: string } = {}) => {
      boards.push({ ...f });
      return Promise.resolve(findS(f));
    },
    saveBoard,
  } as unknown as Api;
  return { api, boards, saveBoard };
}

function Editor({
  initial,
  readOnly,
  onVis,
  onClose,
}: {
  initial: WidgetPanelSpec;
  readOnly: boolean;
  onVis: (vis: WidgetPanelSpec['vis']) => void;
  onClose: () => void;
}) {
  const [panel, setPanel] = useState(initial);
  return (
    <WidgetEditor
      panel={panel}
      def={BOARD_LIST_DEF}
      pointer="/panels/0"
      fields={[]}
      readOnly={readOnly}
      statusText=""
      original={initial.vis}
      onChange={(patch) => {
        if (patch.vis !== undefined) onVis(patch.vis);
        setPanel((p) => ({ ...p, ...patch }));
      }}
      onRemove={() => undefined}
      onClose={onClose}
    />
  );
}

function setup(o: { options?: VisOptions; readOnly?: boolean } = {}) {
  const { api, boards, saveBoard } = listApi();
  const onVis = vi.fn<(vis: WidgetPanelSpec['vis']) => void>();
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const element = (
    <Editor
      initial={listPanel('p-1', 'Lists', o.options)}
      readOnly={o.readOnly ?? false}
      onVis={onVis}
      onClose={onClose}
    />
  );
  const router = createMemoryRouter([{ path: '/t/:tenant/board/:uid', element }], {
    initialEntries: [`/t/demo/board/pay?${LIST_TIME}`],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>
        <ClockContext.Provider value={createClock(() => Date.parse('2026-11-26T12:00:00Z'))}>
          <TimeZoneContext.Provider value="UTC">
            <RouterProvider router={router} />
          </TimeZoneContext.Provider>
        </ClockContext.Provider>
      </ApiContext.Provider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const dialog = () => screen.getByRole('dialog', { name: 'Edit board list' });
  const show = (mode: string) => within(dialog()).getByRole('radio', { name: mode });
  const field = (name: string) => within(dialog()).getByRole('textbox', { name });
  const queryField = (name: string) => within(dialog()).queryByRole('textbox', { name });
  const preview = () => within(dialog()).getByRole('group', { name: 'Preview' });
  return {
    api,
    boards,
    saveBoard,
    onVis,
    onClose,
    user,
    dialog,
    show,
    field,
    queryField,
    preview,
    router,
  };
}

const lastOptions = (onVis: ReturnType<typeof setup>['onVis']) =>
  onVis.mock.calls.at(-1)?.[0].options;

/** Sets an input's value as one change (a paste or an IME commit). */
function setValue(input: HTMLElement, value: string): void {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

describe('unit:board-list-editor', () => {
  it('Show, Search text and the debounced preview', async () => {
    const h = setup();
    await tick();
    expect(h.show('Starred')).toBeChecked();
    expect(h.queryField('Search text')).toBeNull();
    await h.user.click(h.show('Search'));
    expect(lastOptions(h.onVis)).toEqual({ mode: 'search' });
    expect(h.field('Search text')).toBeInTheDocument();
    expect(h.queryField('Tag')).toBeNull();
    expect(h.field('Search text')).toHaveAccessibleDescription(
      /Boards whose title contains this text or that carry it as a tag/,
    );
    await tick(300);
    const before = h.boards.length;
    for (const c of 'check') {
      setValue(h.field('Search text'), `${(h.field('Search text') as HTMLInputElement).value}${c}`);
      await tick(100);
    }
    expect(lastOptions(h.onVis)).toEqual({ mode: 'search', query: 'check' });
    await tick(149);
    expect(h.boards.slice(before).map((f) => f.q)).toEqual([]);
    await tick(1);
    await tick();
    expect(h.boards.slice(before).map((f) => f.q)).toEqual(['check']);
    expect(within(h.preview()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('Show → Tag: the live tag error, then a valid tag', async () => {
    const h = setup();
    await tick();
    await h.user.click(h.show('Tag'));
    expect(lastOptions(h.onVis)).toEqual({ mode: 'tag' });
    expect(h.queryField('Search text')).toBeNull();
    expect(h.field('Tag')).toHaveAccessibleDescription(/Use one valid tag, in tag mode only\./);
    setValue(h.field('Tag'), 'team:payments');
    expect(lastOptions(h.onVis)).toEqual({ mode: 'tag', tag: 'team:payments' });
    expect(h.field('Tag')).not.toHaveAccessibleDescription(/Use one valid tag/);
  });

  it('Rows takes whole numbers from 1 to 50 only', async () => {
    const h = setup();
    await tick();
    const rows = () => h.field('Rows');
    expect(rows()).toHaveValue('10');
    expect(rows()).toHaveAttribute('inputmode', 'numeric');
    for (const bad of ['0', '51', '2.5', 'x']) {
      h.onVis.mockClear();
      setValue(rows(), bad);
      expect(rows(), bad).toHaveValue(bad);
      expect(rows(), bad).toHaveAccessibleDescription(/Use a whole number from 1 to 50\./);
      expect(h.onVis, bad).not.toHaveBeenCalled();
    }
    setValue(rows(), '20');
    expect(lastOptions(h.onVis)).toEqual({ limit: 20 });
    expect(rows()).not.toHaveAccessibleDescription(/Use a whole number/);
  });

  it('Order: Use during incidents writes the sort and shows the ranking caption', async () => {
    const h = setup();
    await tick();
    await h.user.click(within(h.dialog()).getByRole('button', { name: /Order/ }));
    await h.user.click(await screen.findByRole('option', { name: 'Use during incidents' }));
    expect(lastOptions(h.onVis)).toEqual({ sort: 'incidents' });
    const caption = 'Ranking by use during incidents is available with investigations (M-UI4)';
    const outside = within(h.dialog())
      .getAllByText(caption)
      .filter((el) => !h.preview().contains(el));
    expect(outside).toHaveLength(1);
  });

  it('read-only disables every control', async () => {
    const h = setup({ options: { mode: 'search', query: 'a' }, readOnly: true });
    await tick();
    for (const r of within(h.dialog()).getAllByRole('radio')) expect(r).toBeDisabled();
    expect(h.field('Search text')).toHaveAttribute('readonly');
    expect(h.field('Rows')).toHaveAttribute('readonly');
    expect(within(h.dialog()).getByRole('button', { name: /Order/ })).toBeDisabled();
  });
});

describe('unit:board-spec-board-list (editor leg)', () => {
  it('a control character stays in the field and reaches neither the draft nor a request', async () => {
    const h = setup({ options: { mode: 'search' } });
    await tick(300);
    setValue(h.field('Search text'), 'a');
    expect(lastOptions(h.onVis)).toEqual({ mode: 'search', query: 'a' });
    h.onVis.mockClear();
    setValue(h.field('Search text'), 'a\t');
    setValue(h.field('Search text'), 'a\tb');
    expect(h.field('Search text')).toHaveValue('a\tb');
    expect(h.field('Search text')).toHaveAccessibleDescription(
      /Search text cannot contain control characters/,
    );
    expect(h.onVis).not.toHaveBeenCalled();
    expect(within(h.dialog()).getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(within(h.dialog()).getByRole('status', { name: 'Save status' })).toHaveTextContent(
      'Search text cannot contain control characters',
    );
    await tick(1000);
    expect(h.boards.some((f) => (f.q ?? '').includes('\t'))).toBe(false);
    expect(h.saveBoard).not.toHaveBeenCalled();
  });
});

describe('unit:board-list-preview (body)', () => {
  it('the preview is an inert group named Preview with no link, input or button', async () => {
    const h = setup({ options: { mode: 'search', query: 'check' } });
    await tick(300);
    await tick();
    const p = h.preview();
    // The rows sit in an inert box inside the group.
    const box = p.querySelector('[inert]');
    expect(box).not.toBeNull();
    expect(box?.querySelectorAll('li')).toHaveLength(2);
    expect(within(p).getAllByRole('listitem')).toHaveLength(2);
    expect(within(p).getByText('Checkout overview')).toBeInTheDocument();
    expect(p.querySelectorAll('a, input, button, textarea, select, [tabindex]')).toHaveLength(0);
    expect(within(p).queryByRole('status')).toBeNull();
    expect(p.querySelector('[aria-live]')).toBeNull();
    expect(h.dialog()).toHaveTextContent('Preview');

    // Tab from Title goes to Show, past the preview.
    within(h.dialog()).getByRole('textbox', { name: 'Title' }).focus();
    await h.user.tab();
    expect(p.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(h.show('Search'));

    // A click on a preview row does not navigate.
    const path = h.router.state.location.pathname;
    await h.user.pointer({ keys: '[MouseLeft]', target: within(p).getByText('Checkout overview') });
    expect(h.router.state.location.pathname).toBe(path);
  });
});
