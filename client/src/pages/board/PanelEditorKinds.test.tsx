/**
 * The bar chart in the panel editor (plan #173 Part 3b §4.5; T22 §6.1): Bar chart is an enabled
 * kind with its options field (no Legend), a reducer edit is in the draft, a kind change keeps only
 * valid values, a stored pie stays a disabled option, and an `auto` draft previews with the
 * boards' default set (T22 §4.5, owner).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type DataPanelSpec } from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import {
  editorOn,
  openBoard,
  preview,
  ready,
  settled,
  show,
  type Board,
} from '../../test/boardPanelKit';
import { panel } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { R_A, rangeByVersion } from '../../test/rangeFixtures';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

afterEach(() => {
  cleanup();
  uninstallIntersectionObserver();
});

type Vis = DataPanelSpec['vis'];

interface Editor {
  readonly t: Board;
  readonly d: HTMLElement;
  /** The vis of p-1 in every spec sent to `saveBoard`, in order. */
  readonly save: () => Vis[];
}

async function editor(vis: Vis, answer = R_A): Promise<Editor> {
  const t = openBoard([{ ...panel('p-1', 'Requests', 'http_requests_total'), vis }]);
  t.range.mockResolvedValue(answer);
  const spy = vi.spyOn(t.api, 'saveBoard');
  await ready('Requests');
  show('Requests');
  if (vis.kind !== 'barchart' && vis.kind !== 'pie' && vis.kind !== 'geomap') {
    await settled(t, 'Requests');
  }
  const d = await editorOn(t, 'Requests');
  const save = (): Vis[] =>
    spy.mock.calls.map((c) => c[3].panels[0]?.vis).filter((v): v is Vis => v !== undefined);
  return { t, d, save };
}

async function saveNow({ t, save }: Editor, n: number): Promise<void> {
  await t.user.keyboard('{Control>}s{/Control}');
  await waitFor(() => {
    expect(save()).toHaveLength(n);
  });
}

const visTrigger = (d: HTMLElement): HTMLElement =>
  within(d).getByRole('button', { name: /Visualisation$/ });

async function choose(t: Board, trigger: HTMLElement, option: string): Promise<void> {
  await t.user.click(trigger);
  const found = (await screen.findAllByRole('option')).find((o) => o.textContent === option);
  expect(found, option).toBeDefined();
  if (found !== undefined) await t.user.click(found);
}

describe('editor: the bar chart kind (#173 Part 3b §4.5)', () => {
  it('Bar chart is enabled; choosing it shows its options and no Legend', async () => {
    const e = await editor({ kind: 'line' });
    await e.t.user.click(visTrigger(e.d));
    const bar = (await screen.findAllByRole('option')).find((o) => o.textContent === 'Bar chart');
    expect(bar).toBeDefined();
    expect(bar).not.toHaveAttribute('aria-disabled', 'true');
    if (bar !== undefined) await e.t.user.click(bar);
    await waitFor(() => {
      expect(e.d.querySelector('[data-barchart-options]')).not.toBeNull();
    });
    expect(within(e.d).queryByRole('button', { name: /Legend$/ })).toBeNull();
  });

  it('Reducer Sum is in the draft', async () => {
    const e = await editor({ kind: 'barchart' });
    await waitFor(() => {
      expect(e.d.querySelector('[data-barchart-options]')).not.toBeNull();
    });
    await choose(e.t, within(e.d).getByRole('button', { name: /Reducer$/ }), 'Sum');
    await saveNow(e, 1);
    expect(e.save()[0]).toEqual({ kind: 'barchart', options: { reducer: 'sum' } });
  });

  it('stat {orientation: auto} → barchart drops the orientation', async () => {
    const e = await editor({ kind: 'stat', options: { orientation: 'auto' } });
    await choose(e.t, visTrigger(e.d), 'Bar chart');
    await saveNow(e, 1);
    expect(e.save()[0]).toEqual({ kind: 'barchart' });
  });

  it('a stored pie shows as a disabled option', async () => {
    const e = await editor({ kind: 'pie' });
    await e.t.user.click(visTrigger(e.d));
    const pie = (await screen.findAllByRole('option')).find((o) => o.textContent === 'Pie');
    expect(pie).toBeDefined();
    expect(pie).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('draft preview (T22 §4.5, owner)', () => {
  it('an auto draft with a reducer previews a row-11 answer as a line', async () => {
    const e = await editor({ kind: 'auto', options: { reducer: 'max' } }, rangeByVersion());
    const p = preview(e.d);
    await waitFor(() => {
      expect(p).toHaveAttribute('data-panel-vis', 'line');
    });
    expect(visTrigger(e.d)).toHaveTextContent('Auto (Line)');
  });

  it('Map is an enabled kind with its defaults: no options fieldset, no Legend (#234 Part 3)', async () => {
    const e = await editor({ kind: 'line' });
    await choose(e.t, visTrigger(e.d), 'Map');
    await saveNow(e, 1);
    expect(e.save()[0]).toEqual({ kind: 'geomap' });
    expect(within(e.d).queryByRole('button', { name: /Legend$/ })).toBeNull();
    await e.t.user.click(visTrigger(e.d));
    const map = (await screen.findAllByRole('option')).find((o) => o.textContent === 'Map');
    expect(map).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a v6 server’s refusal of a map reads as unsupported in the editor; other errors keep their text (#234 Part 1 §4.5)', async () => {
    const e = await editor({ kind: 'geomap' });
    const save = vi.spyOn(e.t.api, 'saveBoard').mockRejectedValue(
      new ApiError('invalid', 'invalid board', {
        fields: [
          { pointer: '/panels/0/title', messageKey: 'board.panel.title.tooLong' },
          { pointer: '/panels/0/vis/kind', messageKey: 'board.vis.kind.invalid' },
        ],
      }),
    );
    await e.t.user.type(within(e.d).getByRole('textbox', { name: 'Title' }), ' map');
    await e.t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(visTrigger(e.d)).toHaveAccessibleDescription(
        'This server does not support map panels yet',
      );
    });
    expect(within(e.d).getByRole('textbox', { name: 'Title' })).toHaveAccessibleDescription(
      fieldMessage('board.panel.title.tooLong'),
    );
    expect(e.d.textContent).not.toContain(fieldMessage('board.vis.kind.invalid'));
  });

  it('on any other kind the refused kind keeps its own text', async () => {
    const e = await editor({ kind: 'line' });
    const save = vi.spyOn(e.t.api, 'saveBoard').mockRejectedValue(
      new ApiError('invalid', 'invalid board', {
        fields: [{ pointer: '/panels/0/vis/kind', messageKey: 'board.vis.kind.invalid' }],
      }),
    );
    await e.t.user.type(within(e.d).getByRole('textbox', { name: 'Title' }), ' x');
    await e.t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(visTrigger(e.d)).toHaveAccessibleDescription(fieldMessage('board.vis.kind.invalid'));
    });
  });
});
