/**
 * unit:widget-editor (plan #198 Part 3a §3.2, §4.3, §5; T24-007, T24-014): Edit panel on a Text
 * opens the widget editor; Content, Format and Language edit the draft; a draft the save would
 * refuse shows its error under Content and in the preview and is never rendered; the removals are
 * listed by kind and line only; Done and Remove return focus as the panel editor does.
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardSpec } from '../../api/types';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { type Board, openBoard, openMenu, ready } from '../../test/boardPanelKit';
import { panelOf, stubBoard } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import { installIntersectionObserver } from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { seedWith } from '../../test/seeds';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../security/sanitise/markdown', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../security/sanitise/markdown')>();
  return {
    ...m,
    renderMarkdown: (...a: Parameters<typeof m.renderMarkdown>) => {
      renders.n++;
      return m.renderMarkdown(...a);
    },
  };
});

const FIXTURES = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec');
const widgets = (): BoardSpec =>
  JSON.parse(readFileSync(join(FIXTURES, 'v5-widgets.json'), 'utf8')) as BoardSpec;
const ALL = ['Runbook', 'Request rate query', 'Notes', 'Clocks', 'Requests', 'Local time'];

/** The T24 §10 removal-redaction inputs: a `javascript:` link with secrets, then an HTML block. */
const SECRET =
  '[x](javascript:fetch(\'https://u:hunter2@e.test/?token=abc\'))\n\n<a href="https://e.test/?token=abc">';

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

async function editRunbook(t: Board): Promise<HTMLElement> {
  await ready(...ALL);
  await openMenu(t, 'Runbook');
  await t.user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
  return screen.findByRole('dialog', { name: 'Edit text panel' });
}

async function setContent(t: Board, d: HTMLElement, value: string): Promise<void> {
  const field = within(d).getByRole('textbox', { name: 'Content' });
  await t.user.clear(field);
  await t.user.click(field);
  await t.user.paste(value);
}

function open(): Board {
  return openBoard([], { seed: seedWith({ boards: [stubBoard('b-1', widgets())] }) });
}

describe('unit:widget-editor', () => {
  it('Content, Format and Language edit the draft; Done returns to the panel menu', async () => {
    const t = open();
    const save = vi.spyOn(t.api, 'saveBoard');
    const d = await editRunbook(t);
    await setContent(t, d, '# Hello');
    const preview = within(d).getByRole('region', { name: 'Preview: Runbook' });
    expect(await within(preview).findByRole('heading', { level: 4, name: 'Hello' })).toBeVisible();
    await waitFor(() => {
      expect(panelOf('Runbook').querySelector('h4')?.textContent).toBe('Hello');
    });

    await t.user.click(within(d).getByRole('radio', { name: 'Code' }));
    expect(within(d).getByRole('button', { name: /^Plain text/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(preview.querySelector('pre > code[data-lang="plaintext"]')?.textContent).toBe(
        '# Hello',
      );
    });
    await t.user.click(within(d).getByRole('radio', { name: 'Markdown' }));
    expect(within(d).queryByRole('button', { name: /Language/ })).toBeNull();

    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit text panel' })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Panel menu: Runbook' }),
      );
    });
    await t.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save.mock.calls[0]?.[3].panels[0]?.vis).toEqual({
      kind: 'text',
      options: { mode: 'markdown', content: '# Hello' },
    });
  });

  it('a too-long draft is refused live; removals are listed; Remove returns to Add panel', async () => {
    const t = open();
    const d = await editRunbook(t);
    await setContent(t, d, SECRET);
    const list = await within(d).findByRole('list', { name: 'Not shown in the panel' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Line 1: a link with an unsupported address is shown as text.',
      "Line 3: HTML isn't shown.",
    ]);
    for (const s of ['hunter2', 'token']) expect(list.textContent).not.toContain(s);

    const before = renders.n;
    await setContent(t, d, `${'€'.repeat(21_845)}aa`);
    const content = within(d).getByRole('textbox', { name: 'Content' });
    await waitFor(() => {
      expect(content).toHaveAccessibleDescription('Use at most 65 536 bytes.');
    });
    const preview = within(d).getByRole('region', { name: 'Preview: Runbook' });
    expect(within(preview).getByRole('status')).toHaveTextContent(
      'Preview unavailable: Use at most 65 536 bytes.',
    );
    expect(within(d).queryByRole('list', { name: 'Not shown in the panel' })).toBeNull();
    expect(renders.n).toBe(before);

    await t.user.click(within(d).getByRole('button', { name: 'Remove panel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit text panel' })).toBeNull();
    });
    expect(screen.queryByRole('heading', { level: 3, name: 'Runbook' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add panel' }));
    });
  });
});
