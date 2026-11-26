/**
 * Widget panels on a board (plan #198 Part 1 §4.2, `unit:widget-frame`; T24-002, VIZ-053): a
 * widget has a frame, a title and the layout tools, no query, chart, Explore or Full screen, and
 * shows "not available yet" until its kind is drawn.
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type BoardSpec } from '../../api/types';
import { checkBoardSpec } from '../../boards/spec';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { messages } from '../../i18n/messages.en-GB';
import { calls, flush, openBoard, openMenu, ready, reqs, show } from '../../test/boardPanelKit';
import { panelOf, stubBoard } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import { installIntersectionObserver } from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { seedWith } from '../../test/seeds';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

const FIXTURE = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'v5-widgets.json');

function widgets(): BoardSpec {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as BoardSpec;
}

const WIDGETS = ['Runbook', 'Request rate query', 'Notes', 'Clocks', 'Local time'];
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

describe('unit:widget-frame', () => {
  it('widgets show not available, with no query, chart, Explore or Full screen', async () => {
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
      expect(within(p).getByText(messages['widget.kindUnavailable'])).toBeInTheDocument();
      expect(within(p).queryByRole('link', { name: `Open in Explore: ${title}` })).toBeNull();
      expect(within(p).queryByRole('button', { name: `Open in Explore: ${title}` })).toBeNull();
      expect(within(p).queryByRole('button', { name: `Full screen: ${title}` })).toBeNull();
      expect(p.querySelector('[data-chart-frame]'), title).toBeNull();
    }
    expect(panelOf('Requests')).not.toHaveAttribute('data-widget');
    await openMenu(t, 'Runbook');
    const menu = screen.getByRole('menu', { name: 'Panel menu: Runbook' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Duplicate', 'Remove']);
  });

  it('a selected widget opens no editor', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard').mockRejectedValue(
      new ApiError('invalid', 'invalid board', {
        fields: [{ pointer: '/panels/0/title', messageKey: 'board.panel.title.tooLong' }],
      }),
    );
    await ready(...ALL);
    await t.user.click(await screen.findByRole('button', { name: 'Edit board' }));
    await t.user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(panelOf('Runbook')).toHaveAttribute('data-selected');
    });
    await flush();
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
