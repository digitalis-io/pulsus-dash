/**
 * The board's Tags button and its popover (plan #216 Part 2b §4.2, §5; T24-029):
 * `unit:board-tags-toolbar` (the trigger after Add section, its name and states) and
 * `unit:board-list-mixed` (editor leg: an older server's `/tags` refusal and a newer server's
 * invalid tag, on the status line and in the open popover).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import type { BoardSpec } from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { deferred, EngineWrapper, httpApi, json, stubBoard } from '../../test/boardTestKit';
import { installIntersectionObserver } from '../../test/fakeIntersectionObserver';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { renderApp, type RenderAppOptions } from '../../test/renderApp';
import { seedWith } from '../../test/seeds';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));
vi.mock('../../editor/logqlEditor', () => import('../../test/fakeLogqlEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
});

function open(url: string, o: RenderAppOptions = {}) {
  return renderApp(url, { wrapper: EngineWrapper, ...o });
}

type User = ReturnType<typeof open>['user'];

async function editMode(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Edit board' }));
  await screen.findByRole('button', { name: 'Save' });
}

const toolbar = (): HTMLElement => screen.getByRole('group', { name: 'Board actions' });

function tagged(tags?: string[]): StubApi {
  const spec: BoardSpec = {
    title: 'Tagged',
    ...(tags === undefined ? {} : { tags }),
    panels: [],
    sections: [],
  };
  return new StubApi(seedWith({ boards: [stubBoard('b-1', spec)] }));
}

describe('unit:board-tags-toolbar', () => {
  it('the Tags button follows Add section, named by its text; none in view mode', async () => {
    const { user } = open('/t/demo/board/b-1', { api: tagged(['team:payments', 'noc']) });
    await screen.findByRole('button', { name: 'Edit board' });
    expect(within(toolbar()).queryByRole('button', { name: /^Tags/ })).toBeNull();
    await editMode(user);
    const names = within(toolbar())
      .getAllByRole('button')
      .map((b) => b.textContent);
    const at = names.indexOf('Add section');
    expect(names[at + 1]).toBe('Tags (2)');
    const trigger = within(toolbar()).getByRole('button', { name: 'Tags (2)' });
    expect(trigger).not.toHaveAttribute('aria-label');
    expect(trigger).toHaveAccessibleName(trigger.textContent);
  });

  it('a board without tags shows Tags; Esc closes the popover onto the trigger', async () => {
    const { user } = open('/t/demo/board/b-1', { api: tagged() });
    await editMode(user);
    const trigger = within(toolbar()).getByRole('button', { name: 'Tags' });
    await user.click(trigger);
    const d = await screen.findByRole('dialog', { name: 'Board tags' });
    expect(
      within(d).getByText('No tags yet. Tags let a Board list find this board.'),
    ).toBeVisible();
    await user.type(within(d).getByRole('textbox', { name: 'Add a tag' }), 'noc{Enter}');
    expect(within(d).getByRole('button', { name: 'Remove tag noc' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Board tags' })).toBeNull();
    });
    // The popover restores focus once it has closed.
    await waitFor(() => {
      expect(within(toolbar()).getByRole('button', { name: 'Tags (1)' })).toHaveFocus();
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('the trigger is disabled while saving', async () => {
    const api = tagged();
    const held = deferred<Awaited<ReturnType<StubApi['saveBoard']>>>();
    vi.spyOn(api, 'saveBoard').mockReturnValue(held.promise);
    const { user } = open('/t/demo/board/b-1', { api });
    await editMode(user);
    await user.click(within(toolbar()).getByRole('button', { name: 'Tags' }));
    const d = await screen.findByRole('dialog', { name: 'Board tags' });
    await user.type(within(d).getByRole('textbox', { name: 'Add a tag' }), 'noc{Enter}');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(toolbar()).getByRole('button', { name: 'Tags (1)' })).toBeDisabled();
  });
});

describe('unit:board-list-mixed (editor leg)', () => {
  const refuse = (pointer: string, key: string) =>
    httpApi(() =>
      Promise.resolve(
        json(400, {
          error: {
            code: 'invalid',
            message: 'invalid board',
            fields: [{ pointer, message_key: key }],
          },
        }),
      ),
    );

  async function addAndSave(user: User): Promise<HTMLElement> {
    await editMode(user);
    await user.click(within(toolbar()).getByRole('button', { name: 'Tags' }));
    const d = await screen.findByRole('dialog', { name: 'Board tags' });
    await user.type(within(d).getByRole('textbox', { name: 'Add a tag' }), 'noc{Enter}');
    // Mod+S saves with the popover open.
    await user.keyboard('{Control>}s{/Control}');
    return d;
  }

  it('an older server: “does not accept board tags yet” in both places', async () => {
    const { user } = open('/t/demo/board/b-1', { api: refuse('/tags', 'board.json.unknownKey') });
    const d = await addAndSave(user);
    const text = 'This server does not accept board tags yet';
    await waitFor(() => {
      expect(within(d).getByText(text)).toBeInTheDocument();
    });
    expect(screen.getAllByText(text, { ignore: '[role=dialog] *' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Tags (1)', hidden: true })).toBeInTheDocument();
  });

  it('a newer server: its tag text in both places', async () => {
    const { user } = open('/t/demo/board/b-1', { api: refuse('/tags/0', 'board.tags.invalid') });
    const d = await addAndSave(user);
    const text = fieldMessage('board.tags.invalid');
    await waitFor(() => {
      expect(within(d).getByText(text)).toBeInTheDocument();
    });
    expect(screen.getAllByText(text, { ignore: '[role=dialog] *' })).toHaveLength(1);
  });
});
