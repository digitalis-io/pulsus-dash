/**
 * The panel editor's Query field when the editor chunk fails to load (plan #64 §5.1 `editor picker
 * and fallback`, second case). In its own file: the chunk mock rejects for every test here.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { boardWith, engineWrapper, panel } from '../../test/boardTestKit';
import { fakeEngine } from '../../test/fakeEngine';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { renderApp } from '../../test/renderApp';

vi.mock('../../editor/editor', () => Promise.reject(new Error('stub: chunk failed')));

beforeEach(() => {
  installResizeObserver();
});

describe('panel editor fallback', () => {
  it('editor picker and fallback: the chunk import rejects', async () => {
    const api = new StubApi(boardWith([panel('p-1', 'Requests', 'up')]));
    const { user } = renderApp('/t/demo/board/b-1?from=now-1h&to=now&refresh=off', {
      api,
      wrapper: engineWrapper(fakeEngine()),
    });
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Requests' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    await waitFor(() => {
      expect(within(d).getByRole('alert')).toHaveTextContent(
        'The query editor could not be loaded. Reload the page to try again.',
      );
    });
    const box = within(d).getByRole('textbox', { name: 'Query' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveValue('up');
  });
});
