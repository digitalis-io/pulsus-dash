/**
 * The panel editor's Thresholds and Legend fields (plan #64 Part B §3.10, §4.6): every change is in
 * the draft at once (seen here through the spec a save sends), the vis kind change merges, and an
 * unparsable or out-of-range value blocks the save with its error under the field.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelSpec } from '../../api/types';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { editorOn, openBoard, ready, settled, show, type Board } from '../../test/boardPanelKit';
import { panel } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { R_A } from '../../test/rangeFixtures';

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

type Vis = PanelSpec['vis'];
const TWO: Vis['thresholds'] = {
  direction: 'above',
  steps: [
    { value: 1500, state: 'watch', label: '' },
    { value: 2500, state: 'degraded', label: 'Capacity' },
  ],
};

interface Editor {
  readonly t: Board;
  readonly d: HTMLElement;
  /** The vis of p-1 in every spec sent to `saveBoard`, in order. */
  readonly save: () => Vis[];
}

async function editor(vis: Vis): Promise<Editor> {
  const t = openBoard([{ ...panel('p-1', 'Requests', 'http_requests_total'), vis }]);
  t.range.mockResolvedValue(R_A);
  const spy = vi.spyOn(t.api, 'saveBoard');
  await ready('Requests');
  show('Requests');
  await settled(t, 'Requests');
  const d = await editorOn(t, 'Requests');
  const save = (): Vis[] =>
    spy.mock.calls.map((c) => c[3].panels[0]?.vis).filter((v): v is Vis => v !== undefined);
  return { t, d, save };
}

async function saveNow({ t, d, save }: Editor, n: number): Promise<void> {
  await t.user.keyboard('{Control>}s{/Control}');
  await waitFor(() => {
    expect(save()).toHaveLength(n);
  });
  await waitFor(() => {
    expect(within(d).getByRole('status', { name: 'Save status' })).toHaveTextContent('Saved');
  });
}

async function choose(t: Board, trigger: HTMLElement, option: string): Promise<void> {
  await t.user.click(trigger);
  await t.user.click(await screen.findByRole('option', { name: option }));
}

const values = (d: HTMLElement): string[] =>
  within(d)
    .getAllByRole('textbox', { name: 'Value' })
    .map((x) => (x as HTMLInputElement).value);

describe('panel editor thresholds (#64 Part B §4.6)', () => {
  it('vis kind change keeps thresholds and legend', async () => {
    const vis: Vis = { kind: 'line', thresholds: TWO, legend: { mode: 'hidden' } };
    const e = await editor(vis);
    const { t, d, save } = e;
    await choose(t, within(d).getByRole('button', { name: /Visualisation$/ }), 'Bars');
    await saveNow(e, 1);
    expect(save().at(-1)).toEqual({ ...vis, kind: 'bars' });
  });

  it('add, remove, direction, state, label', async () => {
    const e = await editor({ kind: 'line' });
    const { t, d, save } = e;
    const add = within(d).getByRole('button', { name: 'Add threshold' });
    await t.user.click(add);
    expect(values(d)).toEqual(['0']);
    await t.user.click(add);
    expect(values(d)).toEqual(['0', '1']);
    await choose(t, within(d).getByRole('button', { name: /Worse when$/ }), 'Below the value');
    const states = within(d).getAllByRole('button', { name: /State$/ });
    await choose(t, states[1] as HTMLElement, 'Failing');
    const labels = within(d).getAllByRole('textbox', { name: 'Label' });
    await t.user.type(labels[1] as HTMLElement, 'Cap');
    await saveNow(e, 1);
    expect(save().at(-1)).toEqual({
      kind: 'line',
      thresholds: {
        direction: 'below',
        steps: [
          { value: 0, state: 'degraded', label: '' },
          { value: 1, state: 'failing', label: 'Cap' },
        ],
      },
    });
    await t.user.click(within(d).getByRole('button', { name: 'Remove threshold 2' }));
    expect(values(d)).toEqual(['0']);
    await t.user.click(within(d).getByRole('button', { name: 'Remove threshold 1' }));
    expect(within(d).queryAllByRole('textbox', { name: 'Value' })).toHaveLength(0);
    await saveNow(e, 2);
    const last = save().at(-1);
    expect(last).toEqual({ kind: 'line' });
    expect(last !== undefined && 'thresholds' in last).toBe(false);
  });

  it('an invalid value shows an error and blocks save', async () => {
    const { t, d, save } = await editor({ kind: 'line', thresholds: TWO });
    const value = within(d).getAllByRole('textbox', { name: 'Value' })[0] as HTMLElement;
    await t.user.clear(value);
    await t.user.type(value, 'abc');
    expect(within(d).getByText('Enter a number')).toBeInTheDocument();
    await t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(within(d).getByRole('status', { name: 'Save status' })).toHaveTextContent(
        'Problems to fix before saving: 1',
      );
    });
    expect(value).toHaveAccessibleDescription('Enter a number');
    expect(save()).toHaveLength(0);
  });

  it('an out-of-range value shows the range error and blocks save', async () => {
    const { t, d, save } = await editor({ kind: 'line', thresholds: TWO });
    const value = within(d).getAllByRole('textbox', { name: 'Value' })[0] as HTMLElement;
    await t.user.clear(value);
    await t.user.type(value, '2e15');
    const range = 'Use 0 or a value between 1e-9 and 1e15 in size.';
    expect(within(d).getByText(range)).toBeInTheDocument();
    await t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(within(d).getByRole('status', { name: 'Save status' })).toHaveTextContent(
        'Problems to fix before saving: 1',
      );
    });
    expect(value).toHaveAccessibleDescription(range);
    expect(save()).toHaveLength(0);
  });

  it('legend select stores only hidden', async () => {
    const e = await editor({ kind: 'line' });
    const { t, d, save } = e;
    await choose(t, within(d).getByRole('button', { name: /Legend$/ }), 'Hidden');
    await saveNow(e, 1);
    expect(save().at(-1)).toEqual({ kind: 'line', legend: { mode: 'hidden' } });
    await choose(t, within(d).getByRole('button', { name: /Legend$/ }), 'Table');
    await saveNow(e, 2);
    const last = save().at(-1);
    expect(last).toEqual({ kind: 'line' });
    expect(last !== undefined && 'legend' in last).toBe(false);
  });
});
